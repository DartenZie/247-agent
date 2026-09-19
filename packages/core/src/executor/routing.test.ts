import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runShell } from '../actions/shell.js';
import { NonRetryableError, type ActionRunner, type ActionRunners } from '../actions/types.js';
import { createBus, type EventBus } from '../bus/bus.js';
import { taskSource } from '../bus/matcher.js';
import { config, testEnv, type TestEnv } from '../bus/testing.js';
import { Retry } from '../config/schema.js';
import { staticSecrets } from '../secrets/secrets.js';
import type { EventRecord } from '../store/types.js';
import { backoffDelay, Executor, type ExecutorOptions } from './executor.js';

const tasks = config([
  {
    name: 'fan',
    trigger: { kind: 'event', type: 'x.fan' },
    action: {
      kind: 'shell',
      cmd: ['echo', '{"emails":[{"id":"m1"},{"id":"m2"}],"last":7,"kind":"ok"}'],
      result: 'json_stdout',
    },
    emit: [
      {
        type: 'email.received',
        each: '${result.emails}',
        dedup_key: 'email:${item.id}',
        payload: '${item}',
      },
      {
        type: 'x.classified',
        when: "result.kind != 'ignore'",
        payload: {
          kind: '${result.kind}',
          n: '${result.last}',
          from: '${event.type}',
          run: '${run.task}',
        },
      },
      { type: 'x.never', when: "result.kind == 'ignore'" },
      { type: 'x.empty', each: '${result.missing}' },
    ],
    state_updates: {
      'email.last_uid': '${result.last}',
      'email.meta': { attempt: '${run.attempt}' },
    },
  },
  {
    name: 'uses_state',
    trigger: { kind: 'event', type: 'x.state' },
    action: { kind: 'shell', cmd: ['echo', 'since=${state.email.last_uid}'] },
  },
  {
    name: 'secret',
    trigger: { kind: 'event', type: 'x.secret' },
    action: {
      kind: 'shell',
      cmd: ['sh', '-c', 'test "$P" = hunter2 && echo yes'],
      env: { P: '${secrets.ftp_pass}' },
    },
  },
  {
    name: 'flaky',
    trigger: { kind: 'event', type: 'x.flaky' },
    action: { kind: 'shell', cmd: ['true'] },
    retry: { attempts: 3, backoff: 'fixed', base: '10ms' },
  },
  {
    name: 'bad_emit',
    trigger: { kind: 'event', type: 'x.bademit' },
    action: { kind: 'shell', cmd: ['echo', 'hi'] },
    emit: [{ type: 'y.z', each: '${result}' }],
  },
]);

let env: TestEnv;
let bus: EventBus;
let executor: Executor | undefined;

beforeEach(() => {
  env = testEnv();
  bus = createBus({ store: env.store, clock: env.clock, log: env.log });
  bus.dispatcher.setConfig(tasks);
});
afterEach(async () => {
  await executor?.stop();
  executor = undefined;
  env.close();
});

function make(
  over: Partial<ExecutorOptions> = {},
  runners: ActionRunners = { shell: runShell },
): Executor {
  executor = new Executor({
    store: env.store,
    bus,
    clock: env.clock,
    log: env.log,
    config: () => tasks,
    runners,
    ...over,
  });
  executor.start();
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

/** Fails the first `failures` calls, then succeeds. */
function flakyRunner(
  failures: number,
  error: () => Error = () => new Error('flake'),
): { runner: ActionRunner; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    runner: () => {
      calls++;
      return calls <= failures
        ? Promise.reject(error())
        : Promise.resolve(`ok after ${String(calls)}`);
    },
  };
}

describe('emit routing and state_updates', () => {
  it('fans out `each`, applies `when`, renders payloads and dedup keys, updates state', async () => {
    const ex = make();
    const trigger = publish('x.fan');
    bus.dispatcher.drain();
    await ex.idle();

    const run = env.store.runs.getByTaskAndEvent('fan', trigger.id);
    expect(run?.status).toBe('succeeded');
    const emitted = events().filter((e) => e.source === taskSource('fan'));
    expect(emitted.map((e) => e.type)).toEqual([
      'task.fan.succeeded',
      'email.received',
      'email.received',
      'x.classified',
    ]);
    expect(emitted[1]).toMatchObject({
      dedup_key: 'email:m1',
      payload: { id: 'm1' },
      parent_id: trigger.id,
      correlation_id: trigger.correlation_id,
      depth: 1,
    });
    expect(emitted[2]).toMatchObject({ dedup_key: 'email:m2', payload: { id: 'm2' } });
    expect(emitted[3]?.payload).toEqual({ kind: 'ok', n: 7, from: 'x.fan', run: 'fan' });
    expect(env.store.state.snapshot()).toEqual({
      email: { last_uid: 7, meta: { attempt: 1 } },
    });

    // A second run of the same task: the fan-out is deduplicated, the rest goes through.
    publish('x.fan');
    bus.dispatcher.drain();
    await ex.idle();
    expect(events().filter((e) => e.type === 'email.received')).toHaveLength(2);
    expect(events().filter((e) => e.type === 'x.classified')).toHaveLength(2);
    expect(env.lines.filter((l) => l.msg === 'run.emit_duplicate')).toHaveLength(2);
  });

  it('exposes state to templates', async () => {
    env.store.state.put('email', 'last_uid', 41, 'now');
    const ex = make();
    const trigger = publish('x.state');
    bus.dispatcher.drain();
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('uses_state', trigger.id)?.result).toBe('since=41');
  });

  it('fails the run (without retry) when an emit rule cannot be rendered', async () => {
    const ex = make({ defaultRetry: Retry.parse({ attempts: 3, base: '10ms' }) });
    const trigger = publish('x.bademit');
    bus.dispatcher.drain();
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('bad_emit', trigger.id)).toMatchObject({
      status: 'failed',
      attempt: 1,
      error: expect.stringMatching(/emit\[0\] \(y\.z\): each did not render to an array/) as string,
    });
    expect(events().map((e) => e.type)).toEqual(['x.bademit', 'task.bad_emit.failed']);
  });
});

describe('secrets', () => {
  it('resolves only the secrets the task names, and they never reach the store, log or events', async () => {
    const ex = make({ secrets: staticSecrets({ ftp_pass: 'hunter2', other: 'unused' }) });
    const trigger = publish('x.secret');
    bus.dispatcher.drain();
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('secret', trigger.id)?.result).toBe('yes');
    env.store.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(join(env.dir, 'state.db'), 'latin1')).not.toContain('hunter2');
    expect(JSON.stringify(env.lines)).not.toContain('hunter2');
    expect(JSON.stringify(events())).not.toContain('hunter2');
  });

  it('fails a run whose secret is missing, naming the secret but not retrying', async () => {
    const ex = make({
      secrets: staticSecrets({}),
      defaultRetry: Retry.parse({ attempts: 3, base: '10ms' }),
    });
    const trigger = publish('x.secret');
    bus.dispatcher.drain();
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('secret', trigger.id)).toMatchObject({
      status: 'failed',
      attempt: 1,
      error: 'secret "ftp_pass" is not set',
    });
  });
});

describe('retry', () => {
  it('computes fixed and exponential backoff with a cap', () => {
    expect(backoffDelay(Retry.parse({ backoff: 'fixed', base: '2s' }), 5)).toBe(2000);
    const exp = Retry.parse({ base: '1s', max: '5s' });
    expect([1, 2, 3, 4].map((a) => backoffDelay(exp, a))).toEqual([1000, 2000, 4000, 5000]);
  });

  it('retries a failing run as attempts of the same run and publishes failed only at the end', async () => {
    const flaky = flakyRunner(2);
    const ex = make({}, { shell: flaky.runner });
    const trigger = publish('x.flaky');
    bus.dispatcher.drain();
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('flaky', trigger.id)).toMatchObject({
      status: 'succeeded',
      attempt: 3,
      result: 'ok after 3',
    });
    expect(events().map((e) => e.type)).toEqual(['x.flaky', 'task.flaky.succeeded']);
    expect(env.lines.filter((l) => l.msg === 'run.retry').map((l) => l.attempt)).toEqual([1, 2]);

    const dead = flakyRunner(10);
    const ex2 = make({}, { shell: dead.runner });
    const t2 = publish('x.flaky');
    bus.dispatcher.drain();
    await ex2.idle();
    expect(env.store.runs.getByTaskAndEvent('flaky', t2.id)).toMatchObject({
      status: 'failed',
      attempt: 3,
      error: 'flake',
    });
    expect(dead.calls()).toBe(3);
    const failed = events().filter((e) => e.type === 'task.flaky.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ attempt: 3, error: 'flake' });
  });

  it('does not retry a non-retryable error', async () => {
    const dead = flakyRunner(10, () => new NonRetryableError('config broken'));
    const ex = make({}, { shell: dead.runner });
    const trigger = publish('x.flaky');
    bus.dispatcher.drain();
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('flaky', trigger.id)).toMatchObject({
      status: 'failed',
      attempt: 1,
      error: 'config broken',
    });
    expect(dead.calls()).toBe(1);
  });

  it('recovers a run left running when the policy has attempts left, otherwise fails it', async () => {
    const a = publish('x.flaky'); // attempts: 3
    const b = publish('x.state'); // default: 1 attempt
    bus.dispatcher.drain();
    for (const [task, ev] of [
      ['flaky', a],
      ['uses_state', b],
    ] as const) {
      const run = env.store.runs.getByTaskAndEvent(task, ev.id);
      env.store.runs.setStatus(run?.id ?? '', 'running', { started_at: 'earlier', attempt: 1 });
    }
    const ex = make();
    expect(env.lines.find((l) => l.msg === 'executor.started')).toMatchObject({
      interrupted: 1,
      resumed: 1,
      waiting: 0,
    });
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('flaky', a.id)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
    expect(env.store.runs.getByTaskAndEvent('uses_state', b.id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^interrupted/) as string,
    });
    expect(env.lines.some((l) => l.msg === 'run.recovered')).toBe(true);
  });

  it('stops cleanly in the middle of a backoff and recovers the run on the next start', async () => {
    const flaky = flakyRunner(1);
    // `uses_state` has no retry of its own, so the slow default applies.
    const ex = make(
      { defaultRetry: Retry.parse({ attempts: 3, backoff: 'fixed', base: '10s' }) },
      { shell: flaky.runner },
    );
    const trigger = publish('x.state');
    bus.dispatcher.drain();
    await new Promise((r) => setTimeout(r, 30));
    expect(env.store.runs.getByTaskAndEvent('uses_state', trigger.id)).toMatchObject({
      status: 'running',
      error: 'flake',
    });
    await ex.stop();
    expect(env.lines.filter((l) => l.msg === 'run.abandoned')).toHaveLength(1);
    expect(ex.start()).toMatchObject({ resumed: 1 });
    await ex.idle();
    expect(env.store.runs.getByTaskAndEvent('uses_state', trigger.id)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
  });
});
