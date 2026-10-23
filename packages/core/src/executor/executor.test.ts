import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runConnector } from '../actions/connector.js';
import type { ActionRunner, ActionRunners } from '../actions/types.js';
import { createBus, type EventBus } from '../bus/bus.js';
import { runTaskManually } from '../bus/manual.js';
import { type CompiledConfig, taskSource } from '../bus/matcher.js';
import { config, shell, testEnv, type TestEnv } from '../bus/testing.js';
import { runShell } from '../actions/shell.js';
import { parseManifest } from '../config/connector.js';
import { ConnectorSupervisor } from '../connectors/supervisor.js';
import { createSecretsBackend, SecretsConfig, staticSecrets } from '../secrets/secrets.js';
import type { EventRecord } from '../store/types.js';
import { Executor, type ExecutorOptions } from './executor.js';

const tasks = config([
  {
    name: 'echo',
    trigger: { kind: 'event', type: 'x.go' },
    action: { kind: 'shell', cmd: ['echo', 'hi'] },
  },
  {
    name: 'wide',
    trigger: { kind: 'event', type: 'x.wide' },
    action: shell,
    concurrency: 2,
  },
  { name: 'serial', trigger: { kind: 'event', type: 'x.serial' }, action: shell },
  {
    name: 'slow',
    trigger: { kind: 'event', type: 'x.slow' },
    action: { kind: 'shell', cmd: ['sleep', '30'] },
    timeout: '200ms',
  },
  {
    name: 'model',
    trigger: { kind: 'event', type: 'x.model' },
    action: { kind: 'agent', workspace: { kind: 'temp' }, tools: ['read'], prompt: 'x' },
  },
  {
    name: 'penv',
    trigger: { kind: 'event', type: 'x.penv' },
    action: { kind: 'shell', cmd: ['sh', '-c', 'echo "$MYAPP_X|$HOME"'] },
  },
]);

let env: TestEnv;
let bus: EventBus;
let executor: Executor | undefined;
let current: CompiledConfig;

beforeEach(() => {
  env = testEnv();
  current = tasks;
  bus = createBus({ store: env.store, clock: env.clock, log: env.log });
  bus.dispatcher.setConfig(tasks);
});
afterEach(async () => {
  await executor?.stop();
  executor = undefined;
  env.close();
});

function make(runners: ActionRunners = { shell: runShell }, workers = 4): Executor {
  executor = new Executor({
    store: env.store,
    bus,
    clock: env.clock,
    log: env.log,
    config: () => current,
    runners,
    workers,
  });
  return executor;
}

function publish(type: string, payload: unknown = null): EventRecord {
  const r = bus.publish({ type, source: 'test', payload: payload as never });
  if (r.status !== 'inserted') {
    throw new Error('dup');
  }
  return r.event;
}

const events = (): EventRecord[] => env.store.events.listAfter(0, 100);
const lifecycle = (): EventRecord[] => events().filter((e) => e.type.startsWith('task.'));

/** A runner whose completion the test controls. */
function deferredRunner(): {
  runner: ActionRunner;
  active: () => number;
  calls: number;
  finish: (value?: unknown, err?: Error) => void;
} {
  const waiting: { resolve: (v: never) => void; reject: (e: Error) => void }[] = [];
  const state = {
    calls: 0,
    active: () => waiting.length,
    finish: (value: unknown = null, err?: Error) => {
      const w = waiting.shift();
      if (w === undefined) {
        throw new Error('nothing active');
      }
      if (err) {
        w.reject(err);
      } else {
        w.resolve(value as never);
      }
    },
    runner: ((_action, ctx) => {
      state.calls++;
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        ctx.signal.addEventListener('abort', () => {
          const i = waiting.findIndex((w) => w.reject === reject);
          if (i >= 0) {
            waiting.splice(i, 1);
          }
          reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('abort'));
        });
      });
    }) as ActionRunner,
  };
  return state;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Resolves once `cond` holds; fails after `ms`. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Executor', () => {
  it('runs a queued shell action and publishes task.<name>.succeeded from the task', async () => {
    const ex = make();
    ex.start();
    const trigger = publish('x.go');
    bus.dispatcher.drain();
    await ex.idle();

    const run = env.store.runs.getByTaskAndEvent('echo', trigger.id);
    expect(run).toMatchObject({ status: 'succeeded', attempt: 1, result: 'hi', error: null });
    expect(run?.started_at).not.toBeNull();
    expect(run?.finished_at).not.toBeNull();

    const [done] = lifecycle();
    expect(done).toMatchObject({
      type: 'task.echo.succeeded',
      source: taskSource('echo'),
      parent_id: trigger.id,
      correlation_id: trigger.correlation_id,
      depth: 1,
      payload: { run_id: run?.id, task: 'echo', result: 'hi' },
    });
    expect(env.lines.filter((l) => l.msg === 'run.succeeded')).toMatchObject([
      { run_id: run?.id, task: 'echo', correlation_id: trigger.correlation_id },
    ]);
  });

  it('fails the run with the error message and publishes task.<name>.failed', async () => {
    const ex = make({ shell: () => Promise.reject(new Error('disk on fire')) });
    ex.start();
    const trigger = publish('x.go');
    bus.dispatcher.drain();
    await ex.idle();

    const run = env.store.runs.getByTaskAndEvent('echo', trigger.id);
    expect(run).toMatchObject({
      status: 'failed',
      attempt: 1,
      error: 'disk on fire',
      result: null,
    });
    expect(lifecycle()).toMatchObject([
      {
        type: 'task.echo.failed',
        source: taskSource('echo'),
        parent_id: trigger.id,
        payload: { run_id: run?.id, task: 'echo', error: 'disk on fire', attempt: 1 },
      },
    ]);
  });

  it('fails runs whose action kind has no runner or whose task was removed', async () => {
    const ex = make();
    ex.start();
    const m = publish('x.model');
    bus.dispatcher.drain();
    await ex.idle();
    const gone = publish('x.go');
    current = { tasks: [], byName: new Map() }; // a reload dropped every task
    bus.dispatcher.drain();
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('model', m.id)?.error).toBe(
      'action kind "agent" has no runner',
    );
    expect(env.store.runs.getByTaskAndEvent('echo', gone.id)?.error).toBe(
      'task "echo" is no longer configured',
    );
  });

  it('enforces per-task concurrency and the global worker cap', async () => {
    const d = deferredRunner();
    const ex = make({ shell: d.runner }, 3);
    ex.start();
    for (let i = 0; i < 4; i++) {
      publish('x.wide', i);
    }
    publish('x.serial', 'a');
    publish('x.serial', 'b');
    bus.dispatcher.drain();
    await tick();
    // 2 wide (task cap) + 1 serial (task cap) = 3 = global cap; 2 wide + 1 serial pending.
    expect(d.active()).toBe(3);
    expect(ex.stats()).toEqual({ pending: 3, in_flight: 3 });
    expect(
      env.store.runs
        .listByStatus('running')
        .map((r) => r.task)
        .sort(),
    ).toEqual(['serial', 'wide', 'wide']);

    d.finish('one');
    await tick();
    expect(d.active()).toBe(3); // a third wide took the slot; serial still waits on its cap
    expect(
      env.store.runs
        .listByStatus('running')
        .map((r) => r.task)
        .sort(),
    ).toEqual(['serial', 'wide', 'wide']);

    while (d.active() > 0) {
      d.finish('done');
      await tick();
    }
    await ex.idle();
    expect(env.store.runs.listByStatus('succeeded')).toHaveLength(6);
    expect(d.calls).toBe(6);
  });

  describe('a run waiting out its retry backoff', () => {
    /** `flaky` fails once with a retryable error, then succeeds; `urgent` is held by `d`. */
    function setup(base: string): {
      ex: Executor;
      d: ReturnType<typeof deferredRunner>;
      flakyCalls: () => number;
    } {
      current = config([
        {
          name: 'flaky',
          trigger: { kind: 'event', type: 'x.flaky' },
          action: { kind: 'shell', cmd: ['flaky'] },
          retry: { attempts: 2, backoff: 'fixed', base },
        },
        { name: 'urgent', trigger: { kind: 'event', type: 'x.urgent' }, action: shell },
      ]);
      bus.dispatcher.setConfig(current);
      const d = deferredRunner();
      let flakyCalls = 0;
      const runner: ActionRunner = (action, ctx) => {
        if (ctx.run.task !== 'flaky') {
          return d.runner(action, ctx);
        }
        flakyCalls++;
        return flakyCalls === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve('ok');
      };
      return { ex: make({ shell: runner }, 1), d, flakyCalls: () => flakyCalls };
    }

    it('frees its worker slot for other runs (#37)', async () => {
      const { ex, d } = setup('1h');
      ex.start();
      const flaky = publish('x.flaky');
      bus.dispatcher.drain();
      await until(() => env.lines.some((l) => l.msg === 'run.retry'));

      publish('x.urgent');
      bus.dispatcher.drain();
      await until(() => d.active() === 1);
      d.finish('done');
      await until(() => env.store.runs.listByStatus('succeeded').length === 1);
      expect(env.store.runs.getByTaskAndEvent('flaky', flaky.id)).toMatchObject({
        status: 'running',
        attempt: 1,
        error: 'flaky',
      });

      // stop() cuts the backoff short and leaves the run for recovery.
      await ex.stop();
      expect(env.store.runs.getByTaskAndEvent('flaky', flaky.id)?.status).toBe('running');
    });

    it('takes a worker slot again before its next attempt', async () => {
      const { ex, d, flakyCalls } = setup('20ms');
      ex.start();
      const flaky = publish('x.flaky');
      bus.dispatcher.drain();
      await until(() => env.lines.some((l) => l.msg === 'run.retry'));
      publish('x.urgent');
      bus.dispatcher.drain();
      await until(() => d.active() === 1);

      // The backoff is over, but `urgent` holds the only worker.
      await new Promise((r) => setTimeout(r, 100));
      expect(flakyCalls()).toBe(1);

      d.finish('done');
      await ex.idle();
      expect(flakyCalls()).toBe(2);
      expect(env.store.runs.getByTaskAndEvent('flaky', flaky.id)).toMatchObject({
        status: 'succeeded',
        attempt: 2,
      });
    });
  });

  it('times out a run by the task timeout and kills the process', async () => {
    const ex = make();
    ex.start();
    const t = publish('x.slow');
    bus.dispatcher.drain();
    const started = Date.now();
    await ex.idle();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(env.store.runs.getByTaskAndEvent('slow', t.id)).toMatchObject({
      status: 'failed',
      error: 'timed out after 200ms',
    });
    expect(lifecycle().map((e) => e.type)).toEqual(['task.slow.failed']);
  });

  it('adopts queued runs and fails interrupted running ones on start', async () => {
    // Two runs dispatched by a previous process: one never started, one mid-flight.
    const a = publish('x.go');
    const b = publish('x.go');
    bus.dispatcher.drain();
    const runB = env.store.runs.getByTaskAndEvent('echo', b.id);
    env.store.runs.setStatus(runB?.id ?? '', 'running', { started_at: 'earlier', attempt: 1 });

    const ex = make();
    expect(ex.start()).toEqual({ interrupted: 1, resumed: 1, waiting: 0 });
    await ex.idle();

    expect(env.store.runs.getByTaskAndEvent('echo', a.id)).toMatchObject({
      status: 'succeeded',
      result: 'hi',
    });
    expect(env.store.runs.getByTaskAndEvent('echo', b.id)).toMatchObject({
      status: 'failed',
      attempt: 1,
      error: expect.stringMatching(/^interrupted/) as string,
    });
    expect(lifecycle().map((e) => [e.type, e.parent_id])).toEqual([
      ['task.echo.failed', b.id],
      ['task.echo.succeeded', a.id],
    ]);
  });

  it('runs each queued run exactly once even if the store and the dispatcher both hand it over', async () => {
    const d = deferredRunner();
    publish('x.go');
    bus.dispatcher.drain(); // queued in the store before the executor exists
    const ex = make({ shell: d.runner });
    ex.start(); // adopts it
    ex.enqueue(env.store.runs.listByStatus('running')); // a late hand-over of the same run
    await tick();
    expect(d.calls).toBe(1);
    d.finish();
    await ex.idle();
    expect(env.store.runs.listByStatus('succeeded')).toHaveLength(1);
  });

  it('stop() aborts runs in flight, leaves them running for recovery, and drops pending ones', async () => {
    const d = deferredRunner();
    const ex = make({ shell: d.runner }, 1);
    ex.start();
    const a = publish('x.serial');
    const b = publish('x.serial');
    bus.dispatcher.drain();
    await tick();
    expect(ex.stats()).toEqual({ pending: 1, in_flight: 1 });

    await ex.stop();
    expect(env.store.runs.getByTaskAndEvent('serial', a.id)?.status).toBe('running');
    expect(env.store.runs.getByTaskAndEvent('serial', b.id)?.status).toBe('queued');
    expect(lifecycle()).toEqual([]);
    expect(env.lines.some((l) => l.msg === 'run.abandoned')).toBe(true);

    // The next start recovers both, as after a crash.
    expect(ex.start()).toEqual({ interrupted: 1, resumed: 1, waiting: 0 });
    await tick();
    d.finish('ok');
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('serial', a.id)?.status).toBe('failed');
    expect(env.store.runs.getByTaskAndEvent('serial', b.id)?.status).toBe('succeeded');
  });

  it('presents a manual run its inner event, or the manual.run event itself', async () => {
    const seen: EventRecord[] = [];
    const ex = make({
      shell: (_a, ctx) => {
        seen.push(ctx.event);
        return Promise.resolve(null);
      },
    });
    ex.start();
    const withInput = runTaskManually(bus, env.store, tasks, 'echo', {
      type: 'x.custom',
      payload: { a: 1 },
    });
    const bare = runTaskManually(bus, env.store, tasks, 'echo');
    await ex.idle();
    expect(seen).toMatchObject([
      { id: withInput.event_id, type: 'x.custom', payload: { a: 1 }, source: 'manual' },
      { id: bare.event_id, type: 'manual.run', payload: { task: 'echo', event: null } },
    ]);
  });
});

describe('the child environment of a shell step', () => {
  afterEach(() => {
    delete process.env.MYAPP_X;
  });

  async function penv(opts: Partial<ExecutorOptions>) {
    executor = new Executor({
      store: env.store,
      bus,
      clock: env.clock,
      log: env.log,
      config: () => current,
      runners: { shell: runShell },
      ...opts,
    });
    executor.start();
    const trigger = publish('x.penv');
    bus.dispatcher.drain();
    await executor.idle();
    const run = env.store.runs.getByTaskAndEvent('penv', trigger.id);
    expect(run?.status).toBe('succeeded');
    return (run?.result as string).split('|') as [string, string];
  }

  it('is scrubbed by the configured backend when no childEnv is given, whatever the prefix', async () => {
    process.env.MYAPP_X = 'leaked';
    const secrets = createSecretsBackend(
      SecretsConfig.parse({ backend: 'env', prefix: 'MYAPP_' }),
      '/etc/247-agent',
      process.env,
    );
    const [secret, home] = await penv({ secrets });
    expect(secret).toBe('');
    expect(home).toBe(process.env.HOME);
  });

  it('is not the env template scope: a narrow scope leaves the child its environment', async () => {
    // `sh` supplies a PATH of its own when none is set, so HOME is the observable one.
    const [, home] = await penv({ env: {} });
    expect(home).toBe(process.env.HOME);
  });

  it('is exactly childEnv plus the action env when given', async () => {
    process.env.MYAPP_X = 'leaked';
    const [secret, home] = await penv({
      env: {},
      childEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', MYAPP_X: 'from-childEnv' },
    });
    expect(secret).toBe('from-childEnv');
    expect(home).toBe('');
  });
});

describe('Executor retrying a connector op', () => {
  const FIXTURES = new URL('../../test/fixtures/', import.meta.url).pathname;
  const retry = { attempts: 2, backoff: 'fixed', base: '10ms' };
  const op = (name: string, args: Record<string, unknown> = {}, timeout?: string) => ({
    kind: 'connector',
    connector: 'fake',
    op: name,
    args,
    ...(timeout === undefined ? {} : { timeout }),
  });
  let sup: ConnectorSupervisor;

  beforeEach(async () => {
    current = config([
      {
        name: 'call_timeout',
        trigger: { kind: 'event', type: 'c.call_timeout' },
        action: op('slow', { ms: 2000 }, '100ms'),
        retry,
      },
      {
        name: 'task_timeout',
        trigger: { kind: 'event', type: 'c.task_timeout' },
        action: op('slow', { ms: 2000 }),
        timeout: '200ms',
        retry,
      },
      {
        name: 'died',
        trigger: { kind: 'event', type: 'c.died' },
        action: op('die'),
        retry,
      },
    ]);
    bus.dispatcher.setConfig(current);
    const m = parseManifest(
      {
        name: 'fake',
        exec: ['node', `${FIXTURES}fake-mcp.ts`],
        restart: { base: '20ms', max: '100ms' },
      },
      '/x/connectors.d/fake.yaml',
    );
    if (!m.ok) {
      throw new Error(JSON.stringify(m.issues));
    }
    sup = new ConnectorSupervisor({
      manifests: [m.config],
      socketPath: '/tmp/oa-test.sock',
      secrets: staticSecrets({}),
      log: env.log,
      env: { PATH: process.env.PATH ?? '' },
    });
    await sup.start();
  });
  afterEach(async () => {
    await executor?.stop();
    executor = undefined;
    await sup.stop();
  });

  /** Runs `task` once; returns the run and how many times the op was called. */
  async function runOnce(
    task: string,
  ): Promise<{ status: string; attempt: number; error: string | null; calls: number }> {
    let calls = 0;
    executor = new Executor({
      store: env.store,
      bus,
      clock: env.clock,
      log: env.log,
      config: () => current,
      runners: {
        connector: (action, ctx) => {
          calls++;
          return runConnector(action, ctx);
        },
      },
      connectors: sup,
    });
    executor.start();
    const trigger = publish(`c.${task}`);
    bus.dispatcher.drain();
    await executor.idle();
    const run = env.store.runs.getByTaskAndEvent(task, trigger.id);
    return {
      status: run?.status ?? 'missing',
      attempt: run?.attempt ?? 0,
      error: run?.error ?? null,
      calls,
    };
  }

  // The connector may still be running the op, or may have done it: a retry could do it twice.
  it('does not retry an op that outlived its call timeout', async () => {
    expect(await runOnce('call_timeout')).toEqual({
      status: 'failed',
      attempt: 1,
      error: 'fake.slow: timed out after 100 ms; it may have taken effect',
      calls: 1,
    });
  });

  it('does not retry an op cut off by the task timeout', async () => {
    expect(await runOnce('task_timeout')).toEqual({
      status: 'failed',
      attempt: 1,
      error: 'fake.slow: cut off (timed out after 200ms); it may have taken effect',
      calls: 1,
    });
  });

  it('does not retry an op whose connector exited before answering', async () => {
    expect(await runOnce('died')).toEqual({
      status: 'failed',
      attempt: 1,
      error: 'fake.die: the connector exited before answering; it may have taken effect',
      calls: 1,
    });
  });
});
