/* eslint-disable require-yield, @typescript-eslint/require-await -- scripted turns are generators by contract, whatever they do */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { execaSync } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AgentConfigOption,
  AgentInfo,
  AgentSession,
  AgentStop,
  AgentUpdate,
  PermissionHandler,
} from '../connectors/acp-types.js';
import { BudgetExceededError } from '../llm/errors.js';
import { fakeLlmPort, type FakePort } from '../llm/testing.js';
import { createLogger } from '../log.js';
import type { NewTranscriptEntry } from '../store/transcripts.js';
import { AgentAction, previousFailure, runAgent } from './agent.js';
import { readAgentResult, resultInstructions } from './agent-result.js';
import { testContext } from './testing.js';
import {
  isRetryable,
  NonRetryableError,
  type ActionContext,
  type AgentClients,
  type AgentOpenOptions,
} from './types.js';

/** What a scripted turn can do: see the prompt, the cwd, ask permission, notice a cancel. */
interface TurnEnv {
  text: string;
  cwd: string;
  ask: PermissionHandler;
  cancelled: () => boolean;
}

type Turn = (env: TurnEnv) => AsyncGenerator<AgentUpdate, AgentStop, undefined>;

interface FakeAgents extends AgentClients {
  opened: AgentOpenOptions[];
  /** The session's config options; `setConfigOption` changes them and records `[id, value]`. */
  config: AgentConfigOption[];
  sets: [string, string][];
  prompts: string[];
  cancels: number;
  closed: number;
}

const select = (
  id: string,
  category: string | undefined,
  values: string[],
  currentValue = values[0] ?? '',
): AgentConfigOption => ({ id, name: id, category, type: 'select', currentValue, values });

/** Like claude-agent-acp: a model picker and an effort level, both selects. */
const agentConfig = (): AgentConfigOption[] => [
  select('model', 'model', ['default', 'claude-sonnet-5', 'claude-opus-5']),
  select('effort', 'thought_level', ['low', 'medium', 'high'], 'medium'),
];

/** An in-memory `AgentClients` whose one connector runs `turn` for every prompt. */
function fakeAgents(turn: Turn, workDir: string, over: Partial<AgentClients> = {}): FakeAgents {
  const fake: FakeAgents = {
    defaults: { max_tool_calls: 40 },
    workDir,
    opened: [],
    config: agentConfig(),
    sets: [],
    prompts: [],
    cancels: 0,
    closed: 0,
    agentNames: () => ['claude'],
    info: (): AgentInfo => ({ name: 'fake-agent', version: '1' }),
    open: (connector, opts) => {
      if (connector !== 'claude') {
        throw new NonRetryableError(`unknown connector "${connector}"`);
      }
      fake.opened.push(opts);
      let cancelled = false;
      const session: AgentSession = {
        sessionId: 'sess_1',
        get configOptions() {
          return fake.config;
        },
        setConfigOption: (id, value) => {
          fake.sets.push([id, value]);
          const option = fake.config.find((o) => o.id === id);
          if (option?.values.includes(value) !== true) {
            return Promise.reject(new Error(`Invalid value for config option ${id}: ${value}`));
          }
          fake.config = fake.config.map((o) => (o.id === id ? { ...o, currentValue: value } : o));
          return Promise.resolve(fake.config);
        },
        prompt: (text) => {
          fake.prompts.push(text);
          return turn({ text, cwd: opts.cwd, ask: opts.onPermission, cancelled: () => cancelled });
        },
        cancel: () => {
          cancelled = true;
          fake.cancels++;
          return Promise.resolve();
        },
        close: () => {
          fake.closed++;
        },
      };
      return Promise.resolve(session);
    },
    ...over,
  };
  return fake;
}

const stop = (over: Partial<AgentStop> = {}): AgentStop => ({
  stopReason: 'end_turn',
  usage: { input: 1000, output: 100 },
  ...over,
});

const writeResult = (cwd: string, doc: unknown): void => {
  writeFileSync(join(cwd, 'RESULT.json'), JSON.stringify(doc));
};

const action = {
  kind: 'agent',
  connector: 'claude',
  workspace: { kind: 'temp' },
  tools: ['read', 'edit', 'execute'],
  bash_allow: ['npm run build'],
  prompt: 'Change ${event.payload.thing}',
};

let dir: string;
let workDir: string;
let llm: FakePort;
let lines: Record<string, unknown>[];
let transcript: NewTranscriptEntry[];

function ctx(agents: AgentClients, over: Partial<ActionContext> = {}): ActionContext {
  lines = [];
  transcript = [];
  return testContext({
    agents,
    llm,
    transcripts: {
      append: (e) => {
        transcript.push(e);
        return transcript.length;
      },
    },
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
    scope: { event: { payload: { thing: 'the banner' } } },
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-agent-'));
  workDir = join(dir, 'work');
  llm = fakeLlmPort({ systemFiles: { 'prompts/sys.md': 'You are careful.' } });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AgentAction schema', () => {
  it('accepts the documented shape with defaults and rejects the old runtime fields', () => {
    const parsed = AgentAction.parse(action);
    expect(parsed).toMatchObject({
      bash_allow: ['npm run build'],
      unasked_execute: 'judge',
      mcp_servers: [],
      result: { path: 'RESULT.json' },
      post: [],
    });
    expect(AgentAction.safeParse({ ...action, runtime: 'acp' }).success).toBe(false);
    expect(AgentAction.safeParse({ ...action, unasked_execute: 'trust' }).success).toBe(false);
    expect(AgentAction.safeParse({ ...action, tools: [] }).success).toBe(false);
    expect(AgentAction.parse({ ...action, model: 'claude-opus-5', effort: 'high' })).toMatchObject({
      model: 'claude-opus-5',
      effort: 'high',
    });
    expect(AgentAction.safeParse({ ...action, effort: '' }).success).toBe(false);
    expect(
      AgentAction.parse({
        ...action,
        mcp_servers: ['email', { connector: 'ftp', ops: ['upload'] }],
      }).mcp_servers,
    ).toEqual([
      { connector: 'email', ops: [] },
      { connector: 'ftp', ops: ['upload'] },
    ]);
    expect(
      AgentAction.safeParse({
        ...action,
        mcp_servers: ['email', { connector: 'email', ops: ['send'] }],
      }).error?.issues[0]?.message,
    ).toBe('connector "email" is listed twice');
    const normalised = AgentAction.parse({ ...action, mcp_servers: ['ftp'] });
    expect(AgentAction.parse(normalised).mcp_servers).toEqual([{ connector: 'ftp', ops: [] }]);
    expect(AgentAction.safeParse({ ...action, mcp_servers: ['Email'] }).success).toBe(false);
    expect(AgentAction.safeParse({ ...action, system_file: 'p/${event.x}.md' }).success).toBe(
      false,
    );
    expect(
      AgentAction.safeParse({ ...action, workspace: { kind: 'git-worktree', repo: '/r' } }).success,
    ).toBe(true);
  });
});

describe('runAgent', () => {
  it('runs a turn, applies the policy, reads RESULT.json, runs the post gates and keeps the workspace', async () => {
    const seen: string[] = [];
    const agents = fakeAgents(async function* (env) {
      seen.push(env.text);
      yield { kind: 'text', text: 'Working. ', messageId: 'm1' };
      const allowed = env.ask({
        toolCall: {
          id: 'c1',
          title: 'npm run build',
          toolKind: 'execute',
          command: 'npm run build',
          locations: [],
        },
        options: [
          { optionId: 'y', kind: 'allow_once' },
          { optionId: 'n', kind: 'reject_once' },
        ],
      });
      const denied = env.ask({
        toolCall: {
          id: 'c2',
          title: 'curl',
          toolKind: 'execute',
          command: 'curl x',
          locations: [],
        },
        options: [
          { optionId: 'y', kind: 'allow_once' },
          { optionId: 'n', kind: 'reject_once' },
        ],
      });
      yield {
        kind: 'tool_call',
        id: 'c1',
        title: 'npm run build',
        toolKind: 'execute',
        status: 'completed',
        command: 'npm run build',
        locations: [],
      };
      yield { kind: 'usage', used: 500, size: 200_000, costUsd: 0.02 };
      writeFileSync(join(env.cwd, 'data.txt'), 'changed');
      writeResult(env.cwd, {
        status: 'done',
        summary: `edited (${allowed}/${denied})`,
        files_changed: ['data.txt'],
      });
      return stop();
    }, workDir);
    const c = ctx(agents, { task: { name: 't', budget: { max_usd: 1 } } as never });
    const result = await runAgent(
      {
        ...action,
        system_file: 'prompts/sys.md',
        budget: { max_usd: 0.5 },
        post: [
          { shell: ['sh', '-c', 'test -f data.txt && echo "${result.summary}" > gate.txt'] },
          { shell: ['false'], when: 'result.nothing_here' },
        ],
      },
      c,
    );
    expect(result).toEqual({
      status: 'done',
      summary: 'edited (y/n)',
      files_changed: ['data.txt'],
    });
    const ws = join(workDir, 'run_test');
    expect(readFileSync(join(ws, 'gate.txt'), 'utf8')).toBe('edited (y/n)\n');
    expect(transcript.map((e) => [e.turn, e.kind])).toEqual([
      [1, 'prompt'],
      [1, 'text'],
      [1, 'permission'],
      [1, 'permission'],
      [1, 'tool_call'],
      [1, 'usage'],
      [1, 'stop'],
      [1, 'result'],
    ]);
    expect(transcript[0]?.text).toBe(seen[0]);
    expect(transcript[1]?.text).toBe('Working. ');
    expect(transcript[2]?.data).toMatchObject({ id: 'c1', allowed: true });
    expect(transcript[3]?.data).toMatchObject({
      id: 'c2',
      allowed: false,
    });
    expect((transcript[3]?.data as { reason: string }).reason).toMatch(/curl/);
    expect(transcript[7]?.data).toMatchObject({ status: 'done', summary: 'edited (y/n)' });
    expect(transcript.every((e) => e.run_id === 'run_test')).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('You are careful.\n\nChange the banner\n\n');
    expect(seen[0]).toContain(resultInstructions('RESULT.json', undefined));
    expect(agents.opened[0]).toMatchObject({ cwd: ws, tools: [] });
    expect(llm.turns).toEqual([
      expect.objectContaining({
        turn: {
          provider: 'claude',
          model: 'fake-agent',
          maxUsd: 0.5,
          usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.02 },
        },
      }),
    ]);
    expect(agents.closed).toBe(1);
    expect(lines.filter((l) => l.msg === 'agent.permission')).toMatchObject([
      { allowed: true, tool_kind: 'execute' },
      { allowed: false, reason: expect.stringMatching(/bash_allow/) as string },
    ]);
    expect(lines.filter((l) => l.msg === 'agent.post_gate')).toMatchObject([
      { index: 0, skipped: false },
      { index: 1, skipped: true },
    ]);
    expect(lines.find((l) => l.msg === 'agent.result')).toMatchObject({ status: 'done' });
  });

  it('skips the post gates on a blocked result and still succeeds, so emit can route it', async () => {
    const agents = fakeAgents(async function* (env) {
      writeResult(env.cwd, { status: 'blocked', summary: 'no date given', missing: ['date'] });
      return stop();
    }, workDir);
    const result = await runAgent({ ...action, post: [{ shell: ['false'] }] }, ctx(agents));
    expect(result).toEqual({ status: 'blocked', summary: 'no date given', missing: ['date'] });
    expect(existsSync(join(workDir, 'run_test'))).toBe(true);
    expect(lines.filter((l) => l.msg === 'agent.post_gate')).toEqual([]);
  });

  it('uses the model from the action and defaults from defaults.agent', async () => {
    const agents = fakeAgents(
      async function* (env) {
        writeResult(env.cwd, { status: 'done', summary: 'ok' });
        return stop();
      },
      workDir,
      { defaults: { connector: 'claude', max_tool_calls: 5, budget: { max_usd: 0.25 } } },
    );
    const { connector: _c, ...noConnector } = action;
    await runAgent(
      {
        ...noConnector,
        model: 'claude-sonnet-5',
        mcp_servers: [{ connector: 'ftp', ops: ['upload'] }],
      },
      ctx(agents),
    );
    expect(llm.turns[0]?.turn).toMatchObject({ model: 'claude-sonnet-5', maxUsd: 0.25 });
    expect(agents.opened[0]?.tools).toEqual([{ connector: 'ftp', ops: ['upload'] }]);
  });

  it('sets model, then effort, as session config options before the first prompt', async () => {
    const agents = fakeAgents(async function* (env) {
      expect(agents.sets).toHaveLength(2);
      writeResult(env.cwd, { status: 'done', summary: 'ok' });
      return stop();
    }, workDir);
    await runAgent({ ...action, model: 'claude-opus-5', effort: 'high' }, ctx(agents));
    expect(agents.sets).toEqual([
      ['model', 'claude-opus-5'],
      ['effort', 'high'],
    ]);
    expect(lines.find((l) => l.msg === 'agent.config')).toMatchObject({
      model: 'claude-opus-5',
      effort: 'high',
    });
  });

  it('finds the options by category and leaves unset ones to the agent', async () => {
    const agents = fakeAgents(async function* (env) {
      writeResult(env.cwd, { status: 'done', summary: 'ok' });
      return stop();
    }, workDir);
    agents.config = [
      select('mode', 'mode', ['read-only', 'auto']),
      select('reasoning_effort', 'thought_level', ['minimal', 'low', 'high'], 'low'),
      select('model', 'model', ['gpt-5.6-sol']),
    ];
    await runAgent({ ...action, effort: 'minimal' }, ctx(agents));
    expect(agents.sets).toEqual([['reasoning_effort', 'minimal']]);
    expect(lines.find((l) => l.msg === 'agent.config')).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'minimal',
    });
    agents.sets = [];
    await runAgent(action, ctx(agents));
    expect(agents.sets).toEqual([]);
  });

  it('fails before the prompt when the agent has no such option or refuses the value', async () => {
    const agents = fakeAgents(async function* () {
      return stop();
    }, workDir);
    agents.config = [select('model', 'model', ['default', 'claude-sonnet-5'])];
    const noEffort = await runAgent({ ...action, effort: 'high' }, ctx(agents)).catch(
      (e: unknown) => e,
    );
    expect(noEffort).toBeInstanceOf(NonRetryableError);
    expect(String(noEffort)).toMatch(
      /agent "claude" offers no thought_level config option to set effort "high"; its options: model \(model\)/,
    );
    const refused = await runAgent({ ...action, model: 'claude-opus-5' }, ctx(agents)).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(NonRetryableError);
    expect(String(refused)).toMatch(
      /refused model "claude-opus-5" \(Invalid value .*\); it offers default, claude-sonnet-5/,
    );
    expect(agents.prompts).toEqual([]);
    expect(agents.closed).toBe(2);
    expect(existsSync(join(workDir, 'run_test'))).toBe(false);
  });

  it('fails when the agent accepts an effort but does not apply it', async () => {
    const agents = fakeAgents(async function* () {
      return stop();
    }, workDir);
    const open = agents.open.bind(agents);
    agents.open = async (connector, opts) => {
      const session = await open(connector, opts);
      return Object.assign(session, { setConfigOption: () => Promise.resolve(agentConfig()) });
    };
    await expect(runAgent({ ...action, effort: 'low' }, ctx(agents))).rejects.toThrow(
      /left effort at "medium" after it was set to "low"/,
    );
  });

  it('nudges once for a missing RESULT.json, then fails and removes the workspace', async () => {
    let writeOnNudge = true;
    const agents = fakeAgents(async function* (env) {
      if (env.text.startsWith('You have not written') && writeOnNudge) {
        writeResult(env.cwd, { status: 'done', summary: 'late' });
      }
      return stop();
    }, workDir);
    await expect(runAgent(action, ctx(agents))).resolves.toEqual({
      status: 'done',
      summary: 'late',
    });
    expect(agents.prompts).toHaveLength(2);
    expect(llm.turns).toHaveLength(2);
    expect(transcript.map((e) => [e.turn, e.kind])).toEqual([
      [1, 'prompt'],
      [1, 'stop'],
      [2, 'prompt'],
      [2, 'stop'],
      [2, 'result'],
    ]);
    expect(transcript[2]?.text).toMatch(/^You have not written RESULT.json/);

    writeOnNudge = false;
    llm = fakeLlmPort();
    await expect(runAgent(action, ctx(agents))).rejects.toThrow(/did not write RESULT.json/);
    expect(existsSync(join(workDir, 'run_test'))).toBe(false);
    expect(lines.find((l) => l.msg === 'agent.workspace_removed')).toBeDefined();
  });

  it('tells a retry what the previous attempt failed with, and fails a missing result retryably', async () => {
    const agents = fakeAgents(async function* (env) {
      writeResult(env.cwd, { status: 'done', summary: 'ok' });
      return stop();
    }, workDir);
    await runAgent(action, ctx(agents));
    expect(agents.prompts[0]).not.toContain('previous attempt');

    const run = { ...testContext().run, attempt: 2, error: 'post[0] (npm run build) failed: boom' };
    await runAgent(action, ctx(agents, { run }));
    const retried = agents.prompts.at(-1) ?? '';
    expect(retried).toContain('This is attempt 2. The previous attempt failed with this error:');
    expect(retried).toContain('post[0] (npm run build) failed: boom');
    expect(retried.indexOf('boom')).toBeGreaterThan(retried.indexOf('Change the banner'));
    expect(retried.indexOf('boom')).toBeLessThan(retried.indexOf('When you are finished'));
    expect(previousFailure({ ...run, error: 'x'.repeat(5000) })?.length).toBeLessThan(2300);
    expect(previousFailure({ ...run, attempt: 1 })).toBeUndefined();

    const silent = fakeAgents(async function* () {
      return stop();
    }, workDir);
    const err = await runAgent(action, ctx(silent)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isRetryable(err)).toBe(true);
  });

  it('validates the result against the baseline and result.schema', async () => {
    llm = fakeLlmPort({
      systemFiles: {
        'schemas/x.json': JSON.stringify({
          type: 'object',
          required: ['files_changed'],
          properties: { files_changed: { type: 'array' } },
        }),
      },
    });
    let doc: unknown = { status: 'maybe', summary: 'x' };
    const agents = fakeAgents(async function* (env) {
      writeResult(env.cwd, doc);
      return stop();
    }, workDir);
    const withSchema = { ...action, result: { schema: 'schemas/x.json' } };
    await expect(runAgent(withSchema, ctx(agents))).rejects.toThrow(/RESULT.json: status/);
    doc = { status: 'done', summary: 'x' };
    await expect(runAgent(withSchema, ctx(agents))).rejects.toThrow(/does not match result.schema/);
    doc = { status: 'done', summary: 'x', files_changed: [] };
    await expect(runAgent(withSchema, ctx(agents))).resolves.toMatchObject({ status: 'done' });
    expect(agents.prompts.at(-1)).toContain('"required":["files_changed"]');
  });

  it('cancels the session past max_tool_calls and fails non-retryably', async () => {
    const agents = fakeAgents(async function* (env) {
      for (let i = 0; i < 10 && !env.cancelled(); i++) {
        yield {
          kind: 'tool_call',
          id: `c${String(i)}`,
          title: 'read',
          toolKind: 'read',
          status: 'completed',
          command: undefined,
          locations: [],
        };
      }
      return stop({ stopReason: env.cancelled() ? 'cancelled' : 'end_turn' });
    }, workDir);
    const err = await runAgent({ ...action, max_tool_calls: 3 }, ctx(agents)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(String(err)).toMatch(/max_tool_calls \(3\)/);
    expect(agents.cancels).toBe(1);
    expect(llm.turns).toHaveLength(1); // the cancelled turn is still ledgered
    expect(transcript.filter((e) => e.kind === 'cancel')).toMatchObject([
      { turn: 1, data: { reason: 'tool_calls', detail: null } },
    ]);
    expect(transcript.at(-1)).toMatchObject({ kind: 'stop', data: { stop_reason: 'cancelled' } });
  });

  it('fails the run when the agent runs a tool call outside the policy without asking', async () => {
    const agents = fakeAgents(async function* (env) {
      // A shell tool ran with no permission request: judged from what the update reports.
      yield {
        kind: 'tool_call',
        id: 'c1',
        title: 'Terminal',
        toolKind: 'execute',
        status: 'in_progress',
        command: undefined,
        locations: [],
      };
      yield {
        kind: 'tool_call_update',
        id: 'c1',
        status: 'completed',
        toolKind: undefined,
        command: 'pwd; cat ~/.netrc',
        locations: undefined,
      };
      await sleep(5);
      return stop({ stopReason: env.cancelled() ? 'cancelled' : 'end_turn' });
    }, workDir);
    const err = await runAgent(action, ctx(agents)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(String(err)).toMatch(/outside the policy without asking \(command is not in bash_allow/);
    expect(agents.cancels).toBe(1);
    expect(lines.find((l) => l.msg === 'agent.policy_violation')).toMatchObject({ id: 'c1' });
    expect(existsSync(join(workDir, 'run_1'))).toBe(false);
  });

  it('under unasked_execute: sandboxed, trusts the sandbox for unasked commands but still judges asked ones', async () => {
    const sandboxed = { ...action, unasked_execute: 'sandboxed' };
    const unasked = (id: string, command: string) => ({
      kind: 'tool_call' as const,
      id,
      title: command,
      toolKind: 'execute' as const,
      status: 'completed' as const,
      command,
      locations: [] as string[],
    });
    // Codex-style: sandboxed reads chained with && run without asking; an escape asks.
    const agents = fakeAgents(async function* (env) {
      yield unasked('c1', 'git status && sed -n 1,40p data/events.yaml');
      const escape = {
        id: 'c2',
        title: 'curl http://x',
        toolKind: 'execute' as const,
        locations: [],
      };
      yield { kind: 'tool_call', ...escape, status: 'pending', command: 'curl http://x' };
      env.ask({ toolCall: { ...escape, command: 'curl http://x' }, options: [] });
      yield {
        kind: 'tool_call_update',
        id: 'c2',
        status: 'failed',
        toolKind: undefined,
        command: undefined,
        locations: undefined,
      };
      writeResult(env.cwd, { status: 'done', summary: 'ok' });
      return stop();
    }, workDir);
    await expect(runAgent(sandboxed, ctx(agents))).resolves.toMatchObject({ status: 'done' });
    expect(agents.cancels).toBe(0);
    expect(lines.find((l) => l.msg === 'agent.policy_violation')).toBeUndefined();
    expect(lines.find((l) => l.msg === 'agent.permission')).toMatchObject({
      id: 'c2',
      allowed: false,
      reason: expect.stringMatching(/bash_allow/) as string,
    });

    // Kind and paths are still judged for an unasked call.
    const outside = fakeAgents(async function* (env) {
      yield { ...unasked('c3', 'cat /etc/passwd'), locations: ['/etc/passwd'] };
      await sleep(5);
      return stop({ stopReason: env.cancelled() ? 'cancelled' : 'end_turn' });
    }, workDir);
    const err = await runAgent(sandboxed, ctx(outside)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(String(err)).toMatch(/without asking \(path outside the workspace/);
  });

  it('does not judge a call the agent asked about, nor an execute call with no known command', async () => {
    const agents = fakeAgents(async function* (env) {
      // Asked and refused: the tool fails, the run goes on.
      const fetchCall = { id: 'c1', title: 'Fetch', toolKind: 'fetch' as const, locations: [] };
      yield { kind: 'tool_call', ...fetchCall, status: 'pending', command: undefined };
      env.ask({ toolCall: { ...fetchCall, command: undefined }, options: [] });
      yield {
        kind: 'tool_call_update',
        id: 'c1',
        status: 'failed',
        toolKind: undefined,
        command: undefined,
        locations: undefined,
      };
      // An execute call whose command the agent never reported cannot be judged on it.
      yield {
        kind: 'tool_call',
        id: 'c2',
        title: 'Terminal',
        toolKind: 'execute',
        status: 'completed',
        command: undefined,
        locations: [],
      };
      writeResult(env.cwd, { status: 'done', summary: 'ok' });
      return stop();
    }, workDir);
    await expect(runAgent(action, ctx(agents))).resolves.toMatchObject({ status: 'done' });
    expect(agents.cancels).toBe(0);
    expect(lines.find((l) => l.msg === 'agent.permission')).toMatchObject({
      id: 'c1',
      allowed: false,
    });
  });

  it('cancels the session when the reported cost passes the budget', async () => {
    const agents = fakeAgents(async function* (env) {
      yield { kind: 'usage', used: 10, size: 100, costUsd: 0.4 };
      yield { kind: 'usage', used: 20, size: 100, costUsd: 0.6 };
      await sleep(5);
      return stop({ stopReason: env.cancelled() ? 'cancelled' : 'end_turn' });
    }, workDir);
    const err = await runAgent({ ...action, budget: { max_usd: 0.5 } }, ctx(agents)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(String(err)).toMatch(/\$0.6000, over the run budget of \$0.5/);
    expect(llm.turns[0]?.turn.usage.reportedUsd).toBe(0.6);
  });

  it('refuses before the turn when the budget port does, and maps refusal and self-cancel', async () => {
    llm = fakeLlmPort({
      checkBudget: () => {
        throw new BudgetExceededError('daily', 'daily budget reached');
      },
    });
    let reason: AgentStop['stopReason'] = 'refusal';
    const agents = fakeAgents(async function* () {
      return stop({ stopReason: reason });
    }, workDir);
    await expect(runAgent(action, ctx(agents))).rejects.toThrow(/daily budget reached/);
    expect(agents.opened).toHaveLength(0);

    llm = fakeLlmPort();
    await expect(runAgent(action, ctx(agents))).rejects.toThrow(/refused/);
    reason = 'cancelled';
    await expect(runAgent(action, ctx(agents))).rejects.toThrow(/agent cancelled the turn/);
  });

  it('fails a turn the agent reports no usage or cost for', async () => {
    const agents = fakeAgents(async function* (env) {
      writeResult(env.cwd, { status: 'done', summary: 'x' });
      return stop({ usage: undefined });
    }, workDir);
    await expect(runAgent(action, ctx(agents))).rejects.toThrow(/neither usage nor cost/);
    expect(llm.turns).toHaveLength(1);
  });

  it('cancels on the run signal and rethrows its reason', async () => {
    const controller = new AbortController();
    const agents = fakeAgents(async function* (env) {
      yield { kind: 'text', text: 'starting', messageId: null };
      while (!env.cancelled()) {
        await sleep(5);
      }
      return stop({ stopReason: 'cancelled' });
    }, workDir);
    const p = runAgent(action, ctx(agents, { signal: controller.signal }));
    await sleep(20);
    controller.abort(new Error('timed out after 1s'));
    await expect(p).rejects.toThrow('timed out after 1s');
    expect(agents.cancels).toBe(1);
    expect(existsSync(join(workDir, 'run_test'))).toBe(false);
  });

  it('fails retryably on a failing post gate and removes the workspace', async () => {
    const agents = fakeAgents(async function* (env) {
      writeResult(env.cwd, { status: 'done', summary: 'x' });
      return stop();
    }, workDir);
    const err = await runAgent(
      { ...action, post: [{ shell: ['sh', '-c', 'echo boom >&2; exit 7'] }] },
      ctx(agents),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isRetryable(err)).toBe(true);
    expect(String(err)).toMatch(/post\[0\] \(sh -c echo boom.*\) failed: exit code 7: boom/);
    expect(existsSync(join(workDir, 'run_test'))).toBe(false);
  });

  it('reports configuration problems before touching anything', async () => {
    const agents = fakeAgents(async function* () {
      return stop();
    }, workDir);
    await expect(runAgent(action, ctx(agents, { agents: undefined }))).rejects.toThrow(
      /no connector supervisor/,
    );
    await expect(runAgent(action, ctx(agents, { llm: undefined }))).rejects.toThrow(
      /no llm service/,
    );
    await expect(runAgent({ ...action, connector: 'nope' }, ctx(agents))).rejects.toThrow(
      /unknown acp connector "nope"/,
    );
    const { connector: _c, ...noConnector } = action;
    await expect(runAgent(noConnector, ctx(agents))).rejects.toThrow(/no connector: set/);
    await expect(
      runAgent({ ...action, result: { path: '../RESULT.json' } }, ctx(agents)),
    ).rejects.toThrow(/cannot leave it/);
    expect(agents.opened).toHaveLength(0);
  });

  it('works in a git worktree: kept on success, removed with its branch on failure', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]): string => execaSync('git', args, { cwd: repo }).stdout;
    git('init', '-q', '-b', 'main');
    // In the repo's config, not the env: the post gate's commit in the worktree needs it
    // too, and a CI runner has no global identity.
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@x');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    let status = 'done';
    const agents = fakeAgents(async function* (env) {
      if (!env.text.startsWith('You have not written')) {
        expect(readFileSync(join(env.cwd, 'a.txt'), 'utf8')).toBe('one\n'); // a fresh checkout
      }
      writeFileSync(join(env.cwd, 'a.txt'), 'two\n');
      if (status === 'done') {
        writeResult(env.cwd, { status, summary: 'changed a' });
      }
      return stop();
    }, workDir);
    const cfg = {
      ...action,
      workspace: { kind: 'git-worktree', repo, branch: 'main' },
      post: [{ shell: ['git', 'commit', '-qam', 'agent: ${result.summary}'] }],
    };
    await expect(runAgent(cfg, ctx(agents))).resolves.toMatchObject({ status: 'done' });
    const ws = join(workDir, 'run_test');
    expect(git('worktree', 'list')).toContain(ws);
    expect(execaSync('git', ['log', '-1', '--format=%s'], { cwd: ws }).stdout).toBe(
      'agent: changed a',
    );
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n'); // the base checkout is untouched
    expect(git('branch', '--list', 'agent/run_test')).toContain('agent/run_test');

    // A retry replaces the worktree; a failure removes it and its branch.
    status = 'none';
    await expect(runAgent(cfg, ctx(agents))).rejects.toThrow(/did not write/);
    expect(existsSync(ws)).toBe(false);
    expect(git('worktree', 'list')).not.toContain(ws);
    expect(git('branch', '--list', 'agent/run_test')).toBe('');
  });
});

describe('readAgentResult', () => {
  it('reports missing, non-JSON, baseline and schema failures distinctly', () => {
    const ws = join(dir, 'ws');
    mkdirSync(ws);
    expect(readAgentResult(ws, 'RESULT.json', undefined)).toEqual({ ok: false, missing: true });
    writeFileSync(join(ws, 'RESULT.json'), '{not json');
    expect(readAgentResult(ws, 'RESULT.json', undefined)).toMatchObject({
      ok: false,
      missing: false,
      error: expect.stringMatching(/not JSON/) as string,
    });
    writeFileSync(join(ws, 'RESULT.json'), '{"status":"done"}');
    expect(readAgentResult(ws, 'RESULT.json', undefined)).toMatchObject({
      error: expect.stringMatching(/summary/) as string,
    });
    writeFileSync(join(ws, 'RESULT.json'), '{"status":"done","summary":"s","n":"x"}');
    expect(
      readAgentResult(ws, 'RESULT.json', { type: 'object', properties: { n: { type: 'number' } } }),
    ).toMatchObject({ error: expect.stringMatching(/does not match result.schema: n/) as string });
    expect(readAgentResult(ws, 'RESULT.json', undefined)).toEqual({
      ok: true,
      result: { status: 'done', summary: 's', n: 'x' },
    });
    expect(() => readAgentResult(ws, '../x.json', undefined)).toThrow(/inside the workspace/);
  });
});
