import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { createSequenceRunner, type SequenceStepAction } from './actions/sequence.js';
import { runShell } from './actions/shell.js';
import { NonRetryableError, withScope, type ActionContext } from './actions/types.js';
import { eventView } from './actions/wait.js';
import { compileTask, MANUAL_RUN, taskSource, type MatchVerdict } from './bus/matcher.js';
import { parseDuration } from './config/duration.js';
import { applyParams } from './config/params.js';
import type { TaskConfig } from './config/schema.js';
import { taskActions, type TaskAction } from './config/walk.js';
import { contextEvent, renderEmits, renderStateUpdates } from './executor/executor.js';
import type { TemplateScope } from './expr/template.js';
import { nullLogger, type Logger } from './log.js';
import { scrubEnv } from './secrets/secrets.js';
import type { StateSnapshot } from './store/state.js';
import type { EventRecord, JsonValue, RunRecord } from './store/types.js';

/**
 * `oa dry-run` (docs/reference/cli.md): runs one task against a sample event with its model,
 * connector and wait steps answered from a stub file. No store, no daemon, no network or
 * model call, no ledger entry; `shell` steps run for real unless stubbed. What the run
 * would emit and write to state is reported, never applied.
 */

const Stubs = z.strictObject({
  /** The result of each stubbed step by its path: `action`, or `action.steps[<k>]`. */
  results: z.record(z.string(), z.unknown()).default({}),
  /** The KV store as the run sees it: `{<namespace>: {<key>: <value>}}`. */
  state: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export interface DryRunStubs {
  results: Record<string, JsonValue>;
  state: StateSnapshot;
}

/** Reads an event or stub file: YAML, so JSON too. Throws with the file name. */
export function readDataFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${errorMessage(err)}`, { cause: err });
  }
  try {
    return parseYaml(text) as unknown;
  } catch (err) {
    throw new Error(`${path}: invalid YAML: ${errorMessage(err)}`, { cause: err });
  }
}

/** Validates a parsed stub file; throws with the zod issues when it does not fit. */
export function parseStubs(doc: unknown): DryRunStubs {
  const r = Stubs.safeParse(doc ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) =>
      i.path.length === 0 ? i.message : `${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`invalid stub file: ${issues.join('; ')}`);
  }
  return r.data as DryRunStubs;
}

/** The sample event: its type is required for an `event` trigger, else `manual.input`. */
export interface DryRunEvent {
  type?: string | undefined;
  source?: string | undefined;
  payload?: JsonValue | undefined;
}

/** An event the run would publish, as `emit` rendered it. */
export interface DryRunEmit {
  type: string;
  dedup_key?: string;
  payload: JsonValue;
}

export type DryRunReport =
  | {
      ok: true;
      result: JsonValue;
      emitted: DryRunEmit[];
      state_updates: { namespace: string; key: string; value: JsonValue }[];
    }
  | { ok: false; error: string };

export interface DryRunInput {
  task: TaskConfig;
  /** Absent for a manual or cron task run without input. */
  event?: DryRunEvent | undefined;
  stubs: DryRunStubs;
  /** The `env` scope and what a `shell` step starts from; defaults to `process.env` scrubbed. */
  env?: Record<string, string> | undefined;
  log?: Logger | undefined;
}

/** Kinds that reach outside the process: they need a stub. A `shell` step may have one. */
/** A task's action, or a sequence step as the sequence hands it over (without `when`). */
type StepAction = TaskAction | SequenceStepAction;

const NEEDS_STUB: ReadonlySet<StepAction['kind']> = new Set([
  'llm',
  'decide',
  'agent',
  'connector',
  'wait',
]);

const RUN_ID = 'run_dryrun';
const EVENT_ID = 'evt_dryrun';
const CORRELATION_ID = 'cor_dryrun';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function label(at: string, action: StepAction): string {
  return action.kind === 'connector'
    ? `${at} (connector ${action.connector}.${action.op})`
    : `${at} (${action.kind})`;
}

function noMatch(task: string, verdict: Exclude<MatchVerdict, { matched: true }>): string {
  const why =
    verdict.reason === 'filter'
      ? `filter ${verdict.detail} is false`
      : verdict.reason === 'filter_error'
        ? `filter failed: ${verdict.detail}`
        : verdict.reason === 'own_source'
          ? `it comes from the task itself (${verdict.detail})`
          : `the trigger ${verdict.detail}`;
  return `the event does not trigger task "${task}": ${why}`;
}

/**
 * The trigger event the run sees, as the dispatcher would hand it over: the sample event
 * itself for an `event` trigger (which it must match), else a `manual.run` carrying it, as
 * `oa run <task> --payload` does.
 */
function triggerEvent(task: TaskConfig, sample: DryRunEvent | undefined): EventRecord | string {
  const base = {
    seq: 0,
    id: EVENT_ID,
    ts: new Date().toISOString(),
    correlation_id: CORRELATION_ID,
    parent_id: null,
    dedup_key: null,
    depth: 0,
  };
  const trigger = task.trigger;
  if (trigger.kind === 'event') {
    if (sample?.type === undefined) {
      return `task "${task.name}" has an event trigger: the event file needs a "type"`;
    }
    const event: EventRecord = {
      ...base,
      type: sample.type,
      source: sample.source ?? 'dry-run',
      payload: sample.payload ?? null,
    };
    const verdict = compileTask(task).explain(event);
    return verdict.matched ? event : noMatch(task.name, verdict);
  }
  let inner: { type: string; payload: JsonValue } | null =
    sample === undefined
      ? null
      : { type: sample.type ?? 'manual.input', payload: sample.payload ?? null };
  if (trigger.kind === 'manual' && trigger.params !== undefined) {
    const checked = applyParams(trigger.params, sample?.payload);
    if (!checked.ok) {
      const issues = checked.issues.map((i) =>
        i.path === '' ? i.message : `${i.path}: ${i.message}`,
      );
      return `invalid params for task "${task.name}": ${issues.join('; ')}`;
    }
    inner = { type: sample?.type ?? 'manual.input', payload: checked.payload };
  }
  return {
    ...base,
    type: MANUAL_RUN,
    source: 'manual',
    payload: { task: task.name, event: inner },
  };
}

export async function dryRun(input: DryRunInput): Promise<DryRunReport> {
  const { task, stubs } = input;
  const actions = taskActions(task, 'action').filter((a) => a.action.kind !== 'sequence');
  const paths = new Set(actions.map((a) => a.at));
  for (const at of Object.keys(stubs.results)) {
    if (!paths.has(at)) {
      return {
        ok: false,
        error: `the stub file has results for ${at}, which task "${task.name}" has no step at`,
      };
    }
  }
  const trigger = triggerEvent(task, input.event);
  if (typeof trigger === 'string') {
    return { ok: false, error: trigger };
  }
  const event = contextEvent(trigger);
  const env = input.env ?? scrubEnv(process.env);
  const run: RunRecord = {
    id: RUN_ID,
    task: task.name,
    event_id: trigger.id,
    correlation_id: trigger.correlation_id,
    status: 'running',
    attempt: 1,
    created_at: trigger.ts,
    started_at: trigger.ts,
    finished_at: null,
    result: null,
    error: null,
  };
  const runView: Record<string, JsonValue> = {
    id: run.id,
    task: run.task,
    attempt: run.attempt,
    event_id: run.event_id,
    correlation_id: run.correlation_id,
    workspace: null,
  };
  // No credentials: a template that names a secret sees a placeholder.
  const secrets = new Proxy(
    {},
    {
      get: (_t, name) => (typeof name === 'string' ? `<secret ${name}>` : undefined),
    },
  );
  const scope: TemplateScope = {
    event: eventView(event),
    state: stubs.state,
    secrets,
    env,
    run: runView,
  };

  const step = (at: string, action: StepAction, ctx: ActionContext): Promise<JsonValue> => {
    if (Object.hasOwn(stubs.results, at)) {
      return Promise.resolve(stubs.results[at] ?? null);
    }
    if (NEEDS_STUB.has(action.kind)) {
      return Promise.reject(
        new NonRetryableError(
          `${label(at, action)} has no stub: add results."${at}" to the stub file`,
        ),
      );
    }
    return runShell(action, ctx);
  };
  const action = task.action;
  const runner =
    action.kind === 'sequence'
      ? createSequenceRunner((s, i, ctx) => step(`action.steps[${String(i)}]`, s, ctx))
      : (_: unknown, ctx: ActionContext) => step('action', action, ctx);

  const controller = new AbortController();
  const timer =
    task.timeout === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new Error(`timed out after ${task.timeout ?? ''}`));
        }, parseDuration(task.timeout));
  const base: ActionContext = {
    run,
    event,
    task,
    signal: controller.signal,
    log: input.log ?? nullLogger,
    state: stubs.state,
    secrets,
    scope,
    childEnv: env,
    render: () => null,
    renderText: () => '',
    suspend: () => Promise.reject(new NonRetryableError('a wait cannot suspend a dry run')),
    saveProgress: () => undefined,
  };
  let result: JsonValue;
  try {
    result = await runner(action, withScope(base, {}));
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }

  const finish: TemplateScope = {
    event: eventView(event),
    result,
    state: stubs.state,
    env,
    run: runView,
  };
  try {
    const emitted = renderEmits(
      task.emit ?? [],
      finish,
      taskSource(task.name),
      trigger.id,
      () => CORRELATION_ID,
    ).map((e): DryRunEmit => ({
      type: e.type,
      ...(e.dedup_key === undefined ? {} : { dedup_key: e.dedup_key }),
      payload: e.payload ?? null,
    }));
    const state_updates = renderStateUpdates(task.state_updates, finish);
    return { ok: true, result, emitted, state_updates };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
