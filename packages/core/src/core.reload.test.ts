import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionRunner } from './actions/types.js';
import type { Clock } from './clock.js';
import { parseManifest, type ConnectorConfig } from './config/connector.js';
import type { RetentionPolicy } from './config/retention.js';
import {
  createCore,
  defaultRunners,
  type Core,
  type CoreLlmOptions,
  type CoreOptions,
} from './core.js';
import { resolvePricing } from './llm/pricing.js';
import { fakeProviderFactory, type FakeProvider } from './llm/testing.js';
import { createLogger } from './log.js';
import { staticSecrets } from './secrets/secrets.js';

/**
 * Settings from agent.yaml survive a reload through each component's `configure()` seam
 * (#135): every test starts the core with one setting, reloads with another and shows that
 * the running component now behaves by the new one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shell runs stay `running` until the core stops, so a test sees how many run at once. */
const hang: ActionRunner = (_a, ctx) =>
  new Promise((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => {
      reject(ctx.signal.reason as Error);
    });
  });

const TASKS = `tasks:
  - name: a
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["true"] }
  - name: b
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["true"] }
  - name: ask
    trigger: { kind: manual }
    action: { kind: llm, input: hello, output_schema: { type: object } }
  - name: on_ping
    trigger: { kind: event, type: ping }
    action: { kind: shell, cmd: ["true"] }
`;

const keepAll: RetentionPolicy = {
  eventsMs: undefined,
  runsMs: undefined,
  ledgerMs: undefined,
  workspacesMs: undefined,
  intervalMs: 60 * 60 * 1000,
};
const eventsFor1d: RetentionPolicy = { ...keepAll, eventsMs: DAY_MS };

let dir: string;
let now: Date;
let fake: FakeProvider;
let core: Core | undefined;

const clock: Clock = { now: () => now };

const llmWith = (model: string): CoreLlmOptions => ({
  providers: { anthropic: { type: 'anthropic', api_key: '${secrets.key}', headers: {} } },
  pricing: resolvePricing({}),
  defaults: { provider: 'anthropic', model, max_tokens: 1024 },
  budgets: {},
  configDir: dir,
  factories: { anthropic: fake.factory },
});

const idle = (): ConnectorConfig => {
  const r = parseManifest(
    { name: 'x', transport: 'none', exec: ['node', '-e', 'setInterval(() => undefined, 60000)'] },
    '/x/connectors.d/x.yaml',
  );
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }
  return r.config;
};

/** One worker, depth limit 0, at most one run per chain, Haiku, keep everything. */
const startCore = async (over: Partial<CoreOptions> = {}): Promise<Core> => {
  const file = join(dir, 'tasks.yaml');
  writeFileSync(file, TASKS);
  const c = createCore({
    tasksFiles: [file],
    dbPath: join(dir, 'state.db'),
    log: createLogger({ level: 'error', sink: () => undefined }),
    runners: { ...defaultRunners, shell: hang },
    secrets: staticSecrets({ key: 'sk' }),
    clock,
    workers: 1,
    maxEventDepth: 0,
    maxChainRuns: 1,
    llm: llmWith('claude-haiku-4-5'),
    retention: keepAll,
    ...over,
  });
  core = c;
  await c.start();
  // The pass the start runs, so a later `run()` does not just await it.
  await c.retention?.run();
  return c;
};

const status = (c: Core, id: string) => c.store.runs.getById(id)?.status;

/** Whether two manual runs execute at once. */
const twoRunAtOnce = (c: Core): boolean => {
  const a = c.runTask('a').run.id;
  const b = c.runTask('b').run.id;
  return status(c, a) === 'running' && status(c, b) === 'running';
};

/** Publishes an event, under `parent` when given, and returns its id. */
const publish = (c: Core, type: string, parent?: string): string => {
  const r = c.bus.publish({
    type,
    source: 'test',
    payload: {},
    ...(parent === undefined ? {} : { parent_id: parent }),
  });
  if (r.status !== 'inserted') {
    throw new Error('not inserted');
  }
  return r.event.id;
};

/** How many runs of `on_ping` an event one hop below a fresh root starts. */
const childPingRuns = (c: Core): number => {
  const root = publish(c, 'noise');
  publish(c, 'ping', root);
  return c.bus.dispatcher.drain().length;
};

/** How many runs of `on_ping` a second event in the same chain starts, after a first one ran. */
const secondInChainRuns = (c: Core): number => {
  const root = publish(c, 'ping');
  c.bus.dispatcher.drain();
  publish(c, 'ping', root);
  return c.bus.dispatcher.drain().length;
};

/** The model the next `ask` run sends to the provider; waits until the run frees its worker. */
const askedModel = async (c: Core): Promise<string | undefined> => {
  const before = fake.requests.length;
  const id = c.runTask('ask').run.id;
  await vi.waitFor(() => {
    expect(status(c, id)).toBe('succeeded');
  });
  expect(fake.requests.length).toBe(before + 1);
  return fake.requests.at(-1)?.req.model;
};

/** Whether a retention pass deletes an unreferenced event two days old. */
const purgesOldEvent = async (c: Core): Promise<boolean> => {
  const id = publish(c, 'noise');
  c.bus.dispatcher.drain(); // retention keeps events the dispatcher has not passed
  now = new Date(now.getTime() + 2 * DAY_MS);
  await c.retention?.run();
  return c.store.events.getById(id) === undefined;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-reload-'));
  now = new Date('2026-01-01T00:00:00Z');
  fake = fakeProviderFactory();
});

afterEach(async () => {
  await core?.stop();
  core = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('a reload changes the running components (#135)', () => {
  it('lets two blocking runs execute at once after workers: 1 becomes workers: 2', async () => {
    const c = await startCore();
    const a = c.runTask('a').run.id;
    const b = c.runTask('b').run.id;
    expect([status(c, a), status(c, b)]).toEqual(['running', 'queued']);
    expect((await c.reload({ workers: 2 })).ok).toBe(true);
    expect([status(c, a), status(c, b)]).toEqual(['running', 'running']);
  });

  it('dispatches an event one hop deep after max_event_depth goes from 0 to 1', async () => {
    const c = await startCore();
    expect(childPingRuns(c)).toBe(0);
    expect((await c.reload({ maxEventDepth: 1 })).ok).toBe(true);
    expect(childPingRuns(c)).toBe(1);
  });

  it('starts a second run in a chain after max_runs_per_chain goes from 1 to 2', async () => {
    const c = await startCore({ maxEventDepth: 5 });
    expect(secondInChainRuns(c)).toBe(0);
    expect((await c.reload({ maxChainRuns: 2 })).ok).toBe(true);
    expect(secondInChainRuns(c)).toBe(1);
  });

  it('sends the new default model after a reload changes defaults.llm', async () => {
    const c = await startCore({ workers: 4 });
    expect(await askedModel(c)).toBe('claude-haiku-4-5');
    expect((await c.reload({ llm: llmWith('claude-sonnet-5') })).ok).toBe(true);
    expect(await askedModel(c)).toBe('claude-sonnet-5');
  });

  it('purges old events after a reload sets retention.events', async () => {
    const c = await startCore();
    expect(await purgesOldEvent(c)).toBe(false);
    expect((await c.reload({ retention: eventsFor1d })).ok).toBe(true);
    expect(await purgesOldEvent(c)).toBe(true);
  });
});

describe('a reload that fails after validation applies none of its settings (#135)', () => {
  /** A core with a supervised connector, then a reload of every setting whose connector change throws. */
  const failedReload = async (over: Partial<CoreOptions> = {}): Promise<Core> => {
    const c = await startCore({ socketPath: join(dir, 'c.sock'), connectors: [idle()], ...over });
    const supervisor = c.supervisor;
    if (supervisor === undefined) {
      throw new Error('no supervisor');
    }
    const real = supervisor.apply.bind(supervisor);
    vi.spyOn(supervisor, 'apply').mockImplementationOnce(async (m) => {
      await real(m);
      throw new Error('spawn failed');
    });
    const result = await c.reload({
      workers: 2,
      maxEventDepth: 1,
      maxChainRuns: 2,
      llm: llmWith('claude-sonnet-5'),
      retention: eventsFor1d,
      connectors: [],
    });
    expect(result).toMatchObject({ ok: false, error: 'spawn failed' });
    return c;
  };

  it('keeps the workers, max_event_depth, llm defaults and retention', async () => {
    const c = await failedReload();
    expect(childPingRuns(c)).toBe(0);
    expect(await purgesOldEvent(c)).toBe(false);
    expect(await askedModel(c)).toBe('claude-haiku-4-5');
    // Last: the blocking runs hold the only worker.
    expect(twoRunAtOnce(c)).toBe(false);
  });

  it('keeps max_runs_per_chain', async () => {
    // A depth limit that passes the child event, so only the chain cap can stop it.
    const c = await failedReload({ maxEventDepth: 5 });
    expect(secondInChainRuns(c)).toBe(0);
  });
});
