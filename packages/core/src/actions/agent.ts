import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { validateJmespath } from '../config/validators.js';
import { TOOL_KINDS, type AgentSession, type AgentStop } from '../connectors/acp-types.js';
import { isJmesTruthy } from '../expr/jmespath.js';
import { evaluateExpr } from '../expr/template.js';
import { Budget } from '../llm/config.js';
import { BudgetExceededError } from '../llm/errors.js';
import type { LlmCallContext, LlmPort } from '../llm/types.js';
import type { JsonValue } from '../store/types.js';
import {
  decidePermission,
  policyViolation,
  type AgentPolicy,
  type JudgedCall,
} from './agent-policy.js';
import {
  DEFAULT_RESULT_PATH,
  readAgentResult,
  resultInstructions,
  type AgentResult,
} from './agent-result.js';
import { applySessionSettings } from './agent-session-config.js';
import { TranscriptWriter } from './agent-transcript.js';
import {
  createWorkspace,
  gitNoProgramsEnv,
  Workspace,
  type WorkspaceHandle,
} from './agent-workspace.js';
import { runShell, ShellError } from './shell.js';
import { NonRetryableError, withScope, type ActionContext } from './types.js';

const NAME = /^[a-z][a-z0-9_-]*$/;

/** One deterministic gate after a `done` result: argv run in the workspace, templated over `result`. */
const PostGate = z
  .strictObject({
    shell: z.array(z.string().min(1)).min(1),
    env: z.record(z.string(), z.string()).optional(),
    /** JMESPath over `{event, result, state, env, run}`; a falsy value skips the gate. */
    when: z.string().min(1).optional(),
  })
  .superRefine((g, ctx) => {
    if (g.when !== undefined) {
      const err = validateJmespath(g.when);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: ['when'], message: `invalid JMESPath: ${err}` });
      }
    }
  });

/**
 * One `mcp_servers` entry, normalised to `{connector, ops}` (`ops: []` = every op the
 * manifest allows). Parsing the normalised form again yields it unchanged, as the executor
 * re-parses stored actions.
 */
const McpGrant = z.union([
  z
    .string()
    .regex(NAME, 'connector names are [a-z][a-z0-9_-]*')
    .transform((connector) => ({ connector, ops: [] as string[] })),
  z.strictObject({
    connector: z.string().regex(NAME, 'connector names are [a-z][a-z0-9_-]*'),
    ops: z.array(z.string().min(1)).default([]),
  }),
]);

/**
 * docs/internal/agent-action.md: one prompt turn on an ACP agent (`connector`, a `transport: acp`
 * manifest) in a fresh workspace, under a tool-kind allowlist, a shell-command allowlist,
 * a tool-call cap and a budget, ending in a RESULT.json that `emit` rules route on.
 */
export const AgentAction = z
  .strictObject({
    kind: z.literal('agent'),
    /** An acp connector; default `defaults.agent.connector`. */
    connector: z.string().regex(NAME, 'connector names are [a-z][a-z0-9_-]*').optional(),
    /**
     * The session's model, set through the agent's `model` config option (an alias the
     * agent resolves is fine); also prices the reported tokens when the agent reports no
     * cost. Unset: the agent program's own default.
     */
    model: z.string().min(1).optional(),
    /** The session's effort, set through the agent's `thought_level` config option (`low`, `high`, …). */
    effort: z.string().min(1).optional(),
    /** Tool calls allowed in one run before the session is cancelled; default `defaults.agent`. */
    max_tool_calls: z.number().int().positive().optional(),
    budget: Budget.optional(),
    workspace: Workspace,
    /** ACP tool kinds the agent may use; the permission policy refuses the rest. */
    tools: z.array(z.enum(TOOL_KINDS)).min(1),
    /** Commands an `execute` tool call may run: each segment of a linear chain must be one of these or start with one followed by a space. */
    bash_allow: z.array(z.string().min(1)).default([]),
    /**
     * An `execute` call the agent ran without asking: `judge` checks its command against
     * `bash_allow` after the fact (Claude Code asks for everything else); `sandboxed` trusts
     * the agent's own OS sandbox for it and judges only kind and paths (Codex runs sandboxed
     * commands without asking and asks for every escape). Calls that ask are always judged.
     */
    unasked_execute: z.enum(['judge', 'sandboxed']).default('judge'),
    /**
     * Connector ops the agent may call as MCP tools, through the core's tool bridge (the
     * agent never gets the connector's secrets): a `stdio` connector's name for every op
     * its manifest allows, or `{connector, ops}` for some of them.
     */
    mcp_servers: z.array(McpGrant).default([]),
    /** Static text prepended to the prompt (ACP has no separate system channel); relative to agent.yaml. */
    system_file: z.string().min(1).optional(),
    /** Templated; the task itself. */
    prompt: z.string().min(1),
    result: z
      .strictObject({
        /** Relative to the workspace; cannot leave it. */
        path: z
          .string()
          .min(1)
          .refine(
            (p) => !isAbsolute(p) && !p.split(/[\\/]/).includes('..'),
            'result.path is relative to the workspace and cannot leave it',
          )
          .default(DEFAULT_RESULT_PATH),
        /** A JSON Schema file relative to agent.yaml, checked on top of the baseline `{status, summary}`. */
        schema: z.string().min(1).optional(),
      })
      .prefault({}),
    post: z.array(PostGate).default([]),
  })
  .superRefine((a, ctx) => {
    const seen = new Set<string>();
    for (const [i, g] of a.mcp_servers.entries()) {
      if (seen.has(g.connector)) {
        ctx.addIssue({
          code: 'custom',
          path: ['mcp_servers', i],
          message: `connector "${g.connector}" is listed twice`,
        });
      }
      seen.add(g.connector);
    }
    if (a.system_file?.includes('${') === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['system_file'],
        message: 'system_file is a static path; put dynamic content in "prompt"',
      });
    }
  });

export type AgentActionConfig = z.infer<typeof AgentAction>;

/** How long after `session/cancel` the runner waits for the agent to stop before moving on. */
const CANCEL_GRACE_MS = 15_000;
/** Characters of the agent's last message kept for the log. */
const TEXT_KEEP = 2000;

type CancelReason = 'budget' | 'tool_calls' | 'policy' | 'abort';

interface TurnOutcome {
  stop: AgentStop;
  cancelReason: CancelReason | undefined;
  /** What the policy check found when `cancelReason` is `policy`. */
  violation: string | undefined;
  /** Cumulative session cost the agent reported, if any. */
  costUsd: number | undefined;
  text: string;
}

/**
 * The policy applied to tool calls the agent runs *without* asking: `judged` holds the ids
 * that went through `session/request_permission` (the handler adds them), `calls` what each
 * id has reported so far, since agents often send the command or paths in a later update.
 */
interface PolicyWatch {
  policy: AgentPolicy;
  judged: Set<string>;
  calls: Map<string, JudgedCall>;
}

interface TurnLimits {
  maxToolCalls: number;
  maxUsd: number | undefined;
  /** Tool calls already made in earlier turns of this run. */
  toolCallsBefore: number;
  watch: PolicyWatch;
  transcript: TranscriptWriter;
}

/** Statuses at which the tool has run or is running, so asking is no longer possible. */
const STARTED: readonly (string | undefined)[] = ['in_progress', 'completed', 'failed'];

/**
 * Drives one prompt turn: counts tool calls, watches the reported cost, checks tool calls
 * the agent ran without asking against the policy, cancels the session past a limit or on
 * the run's abort, and returns the stop with what it saw.
 */
async function runTurn(
  session: AgentSession,
  text: string,
  limits: TurnLimits,
  ctx: ActionContext,
): Promise<TurnOutcome & { toolCalls: number }> {
  const { watch, transcript } = limits;
  transcript.begin(text);
  const gen = session.prompt(text);
  let toolCalls = limits.toolCallsBefore;
  let costUsd: number | undefined;
  let kept = '';
  let cancelReason: CancelReason | undefined;
  let violation: string | undefined;
  let grace: Promise<never> | undefined;
  const cancel = (reason: CancelReason): void => {
    if (cancelReason !== undefined) {
      return;
    }
    cancelReason = reason;
    ctx.log.warn('agent.cancelling', { reason, tool_calls: toolCalls, cost_usd: costUsd ?? null });
    transcript.cancel(reason, reason === 'policy' ? violation : undefined);
    grace = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`the agent did not stop within ${String(CANCEL_GRACE_MS)}ms of cancel`));
      }, CANCEL_GRACE_MS).unref();
    });
    session.cancel().catch((err: unknown) => {
      ctx.log.warn('agent.cancel_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  const onAbort = (): void => {
    cancel('abort');
  };
  /**
   * A call that has started without a permission request is judged as if it had asked,
   * on every update (a later one may bring the command or the paths).
   */
  const unasked = (id: string, status: string | undefined): void => {
    if (watch.judged.has(id) || !STARTED.includes(status)) {
      return;
    }
    const call = watch.calls.get(id);
    const found =
      call === undefined ? undefined : policyViolation(watch.policy, call, { asked: false });
    if (found !== undefined) {
      violation = found;
      ctx.log.warn('agent.policy_violation', { id, reason: found });
      cancel('policy');
    }
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  if (ctx.signal.aborted) {
    onAbort();
  }
  try {
    for (;;) {
      const next = grace === undefined ? await gen.next() : await Promise.race([gen.next(), grace]);
      if (next.done) {
        transcript.stop(next.value);
        return { stop: next.value, cancelReason, violation, costUsd, text: kept, toolCalls };
      }
      const u = next.value;
      transcript.update(u);
      switch (u.kind) {
        case 'text':
          if (kept.length < TEXT_KEEP) {
            kept += u.text.slice(0, TEXT_KEEP - kept.length);
          }
          break;
        case 'tool_call':
          toolCalls++;
          ctx.log.info('agent.tool_call', {
            id: u.id,
            tool_kind: u.toolKind,
            title: u.title.slice(0, 200),
            command: u.command?.slice(0, 200) ?? null,
            locations: u.locations.slice(0, 20).join(' '),
            n: toolCalls,
          });
          if (toolCalls > limits.maxToolCalls) {
            cancel('tool_calls');
          }
          watch.calls.set(u.id, {
            toolKind: u.toolKind,
            command: u.command,
            locations: u.locations,
          });
          unasked(u.id, u.status);
          break;
        case 'tool_call_update': {
          ctx.log.debug('agent.tool_call_update', { id: u.id, status: u.status ?? null });
          const known = watch.calls.get(u.id);
          if (known !== undefined) {
            watch.calls.set(u.id, {
              toolKind: u.toolKind ?? known.toolKind,
              command: u.command ?? known.command,
              locations: u.locations ?? known.locations,
            });
          }
          unasked(u.id, u.status);
          break;
        }
        case 'usage':
          costUsd = u.costUsd ?? costUsd;
          ctx.log.debug('agent.usage', { used: u.used, size: u.size, cost_usd: u.costUsd ?? null });
          if (limits.maxUsd !== undefined && costUsd !== undefined && costUsd > limits.maxUsd) {
            cancel('budget');
          }
          break;
        case 'thought':
        case 'other':
          break;
      }
    }
  } finally {
    // Not `gen.return()`: a generator parked on `nextUpdate()` would only return once that
    // resolves. `session.close()` disposes the queue, which ends the generator.
    ctx.signal.removeEventListener('abort', onAbort);
    transcript.flush();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('cancelled');
}

function parseSchema(text: string, file: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new NonRetryableError(
      `result.schema ${file} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new NonRetryableError(`result.schema ${file} must be a JSON Schema object`);
  }
  return doc as Record<string, unknown>;
}

/** How much of the previous attempt's error goes into a retry's prompt. */
const PREVIOUS_ERROR_MAX = 2000;

/**
 * On a retry (§10), what the previous attempt failed with: the agent starts in a fresh
 * workspace, so without this it would repeat the same mistake. `undefined` on attempt 1.
 */
export function previousFailure(run: ActionContext['run']): string | undefined {
  if (run.attempt <= 1 || run.error === null || run.error === '') {
    return undefined;
  }
  const error =
    run.error.length <= PREVIOUS_ERROR_MAX
      ? run.error
      : run.error.slice(0, PREVIOUS_ERROR_MAX) + '…';
  return [
    `This is attempt ${String(run.attempt)}. The previous attempt failed with this error:`,
    error,
    'Its changes were discarded: you are starting again from a fresh working directory.',
    'Avoid what caused that failure.',
  ].join('\n');
}

function nudge(path: string, schema: Record<string, unknown> | undefined): string {
  return (
    `You have not written ${path}. Write it now and do nothing else.\n` +
    resultInstructions(path, schema)
  );
}

async function runPostGates(
  gates: AgentActionConfig['post'],
  ws: WorkspaceHandle,
  result: AgentResult,
  ctx: ActionContext,
): Promise<void> {
  if (gates.length === 0) {
    return;
  }
  // A gate runs in the workspace as the daemon user: nothing the agent left there may
  // decide what runs. Git hooks and programs are off, and a swapped `.git` fails the run.
  ws.assertIntact();
  const scoped = withScope(ctx, { result });
  for (const [i, gate] of gates.entries()) {
    const label = `post[${String(i)}] (${gate.shell.join(' ').slice(0, 80)})`;
    if (gate.when !== undefined && !isJmesTruthy(evaluateExpr(gate.when, scoped.scope))) {
      ctx.log.info('agent.post_gate', { index: i, skipped: true });
      continue;
    }
    const startedAt = Date.now();
    try {
      await runShell(
        {
          kind: 'shell',
          cmd: gate.shell,
          cwd: ws.path,
          env: { ...gitNoProgramsEnv(), ...gate.env },
        },
        scoped,
      );
    } catch (err) {
      if (err instanceof ShellError) {
        // Retryable: `retry` repeats the run in a fresh workspace with this error (and the
        // gate's stderr tail) in the prompt, so the agent can fix what the gate caught.
        throw new Error(`${label} failed: ${err.message}`, { cause: err });
      }
      throw err;
    }
    ctx.log.info('agent.post_gate', {
      index: i,
      skipped: false,
      duration_ms: Date.now() - startedAt,
    });
  }
}

export async function runAgent(action: unknown, ctx: ActionContext): Promise<JsonValue> {
  const cfg = AgentAction.parse(action);
  const agents = ctx.agents;
  if (agents === undefined) {
    throw new NonRetryableError(
      'no connector supervisor is configured: agent actions need an acp connector',
    );
  }
  const llm: LlmPort | undefined = ctx.llm;
  if (llm === undefined) {
    throw new NonRetryableError('no llm service is configured');
  }
  const connector = cfg.connector ?? agents.defaults.connector;
  if (connector === undefined) {
    throw new NonRetryableError('no connector: set action.connector or defaults.agent.connector');
  }
  if (!agents.agentNames().includes(connector)) {
    throw new NonRetryableError(`unknown acp connector "${connector}"`);
  }
  const maxToolCalls = cfg.max_tool_calls ?? agents.defaults.max_tool_calls;
  const own = cfg.budget?.max_usd ?? agents.defaults.budget?.max_usd;
  const caps = [own, ctx.task.budget?.max_usd].filter((x) => x !== undefined);
  const maxUsd = caps.length === 0 ? undefined : Math.min(...caps);
  const system = cfg.system_file === undefined ? undefined : llm.readSystemFile(cfg.system_file);
  const schema =
    cfg.result.schema === undefined
      ? undefined
      : parseSchema(llm.readSystemFile(cfg.result.schema), cfg.result.schema);
  const prompt = [
    system,
    ctx.renderText(cfg.prompt),
    previousFailure(ctx.run),
    resultInstructions(cfg.result.path, schema),
  ]
    .filter((s): s is string => s !== undefined)
    .join('\n\n');
  const cctx: LlmCallContext = {
    run: ctx.run,
    task: ctx.task.name,
    signal: ctx.signal,
    log: ctx.log,
  };

  llm.checkBudget({ maxUsd }, cctx);
  const ws = await createWorkspace(cfg.workspace, agents.workDir, ctx.run.id);
  ctx.log.info('agent.workspace', { path: ws.path, kind: cfg.workspace.kind });
  let keep = false;
  try {
    const policy: AgentPolicy = {
      tools: cfg.tools,
      bashAllow: cfg.bash_allow,
      workspace: ws.path,
      unaskedExecute: cfg.unasked_execute,
    };
    const watch: PolicyWatch = { policy, judged: new Set(), calls: new Map() };
    const transcript = new TranscriptWriter({
      sink: ctx.transcripts,
      runId: ctx.run.id,
      secrets: ctx.secrets,
      log: ctx.log,
    });
    const session = await agents.open(connector, {
      cwd: ws.path,
      tools: cfg.mcp_servers,
      signal: ctx.signal,
      log: ctx.log,
      onPermission: (req) => {
        watch.judged.add(req.toolCall.id);
        const d = decidePermission(policy, req);
        transcript.permission(req, d);
        ctx.log.info('agent.permission', {
          id: req.toolCall.id,
          tool_kind: req.toolCall.toolKind,
          title: req.toolCall.title.slice(0, 200),
          allowed: d.allow,
          ...(d.allow ? {} : { reason: d.reason }),
        });
        return d.optionId;
      },
    });
    const model = cfg.model ?? agents.info(connector)?.name ?? connector;
    let toolCalls = 0;
    let chargedUsd = 0;
    const turn = async (text: string): Promise<AgentStop> => {
      const startedAt = Date.now();
      const out = await runTurn(
        session,
        text,
        { maxToolCalls, maxUsd, toolCallsBefore: toolCalls, watch, transcript },
        ctx,
      );
      toolCalls = out.toolCalls;
      const reported =
        out.costUsd === undefined ? undefined : Math.max(0, out.costUsd - chargedUsd);
      if (out.costUsd !== undefined) {
        chargedUsd = out.costUsd;
      }
      const ledgered = llm.record(
        {
          provider: connector,
          model,
          maxUsd,
          usage: {
            input: out.stop.usage?.input ?? 0,
            output: out.stop.usage?.output ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
            reportedUsd: reported,
          },
        },
        cctx,
      );
      ctx.log.info('agent.turn_done', {
        stop_reason: out.stop.stopReason,
        tool_calls: toolCalls,
        usd: ledgered.usd,
        duration_ms: Date.now() - startedAt,
        text: out.text.slice(0, 500),
      });
      if (out.stop.usage === undefined && out.costUsd === undefined) {
        throw new NonRetryableError(
          `agent "${connector}" reported neither usage nor cost for the turn, so the run cannot be budgeted; it is in the ledger at $${ledgered.usd.toFixed(4)}`,
        );
      }
      switch (out.cancelReason) {
        case 'abort':
          throw abortReason(ctx.signal);
        case 'budget':
          throw new BudgetExceededError(
            'task',
            `agent reported $${(out.costUsd ?? 0).toFixed(4)}, over the run budget of $${String(maxUsd)}; session cancelled`,
          );
        case 'tool_calls':
          throw new NonRetryableError(
            `agent exceeded max_tool_calls (${String(maxToolCalls)}); session cancelled`,
          );
        case 'policy':
          throw new NonRetryableError(
            `agent ran a tool call outside the policy without asking (${out.violation ?? 'unknown'}); session cancelled`,
          );
        case undefined:
          break;
      }
      if (out.stop.stopReason === 'refusal') {
        throw new NonRetryableError('the agent refused the request');
      }
      if (out.stop.stopReason === 'cancelled') {
        throw new NonRetryableError('the agent cancelled the turn');
      }
      return out.stop;
    };
    try {
      await applySessionSettings(
        session,
        { model: cfg.model, effort: cfg.effort },
        connector,
        ctx.log,
      );
      await turn(prompt);
      let read = readAgentResult(ws.path, cfg.result.path, schema);
      if (!read.ok && read.missing) {
        ctx.log.warn('agent.result_missing', { path: cfg.result.path });
        await turn(nudge(cfg.result.path, schema));
        read = readAgentResult(ws.path, cfg.result.path, schema);
      }
      if (!read.ok) {
        // Retryable: `retry` repeats it in a fresh workspace with this error in the prompt.
        throw new Error(read.missing ? `the agent did not write ${cfg.result.path}` : read.error);
      }
      const result = read.result;
      transcript.result(result);
      ctx.log.info('agent.result', {
        status: result.status,
        summary: result.summary.slice(0, 500),
        tool_calls: toolCalls,
      });
      if (result.status === 'done') {
        await runPostGates(cfg.post, ws, result, ctx);
      }
      keep = true;
      return result;
    } finally {
      session.close();
    }
  } finally {
    if (!keep) {
      await ws.remove();
      ctx.log.info('agent.workspace_removed', { path: ws.path });
    }
  }
}
