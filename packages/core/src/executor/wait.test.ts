import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSequence } from '../actions/sequence.js';
import { runShell } from '../actions/shell.js';
import { runWait } from '../actions/wait.js';
import { createBus, type EventBus } from '../bus/bus.js';
import { config, testEnv, type TestEnv } from '../bus/testing.js';
import { Retry } from '../config/schema.js';
import type { EventRecord, RunRecord } from '../store/types.js';
import { Executor } from './executor.js';

const gateSteps = (timeout: string, onTimeout: 'fail' | 'succeed' = 'fail'): unknown[] => [
  { kind: 'shell', cmd: ['echo', 'asked ${event.payload.q}'] },
  {
    kind: 'wait',
    for: { type: 'chat.reply', filter: "payload.correlation_id == '${event.correlation_id}'" },
    timeout,
    on_timeout: onTimeout,
  },
  {
    kind: 'shell',
    when: 'steps[1].payload.approved == `true`',
    cmd: ['echo', 'pushed after ${steps[1].payload.text} (${steps[0]})'],
  },
];

const tasks = config([
  {
    name: 'gate',
    trigger: { kind: 'event', type: 'x.ask' },
    action: { kind: 'sequence', steps: gateSteps('1h') },
    retry: { attempts: 3, backoff: 'fixed', base: '10ms' },
  },
  {
    name: 'gate_short',
    trigger: { kind: 'event', type: 'x.ask_short' },
    action: { kind: 'sequence', steps: gateSteps('30s') },
    retry: { attempts: 3, backoff: 'fixed', base: '10ms' },
  },
  {
    name: 'gate_lenient',
    trigger: { kind: 'event', type: 'x.ask_lenient' },
    action: { kind: 'sequence', steps: gateSteps('30s', 'succeed') },
  },
  {
    name: 'plain_wait',
    trigger: { kind: 'event', type: 'x.wait' },
    action: { kind: 'wait', for: { type: 'chat.*' }, timeout: '1h' },
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

function make(): Executor {
  executor = new Executor({
    store: env.store,
    bus,
    clock: env.clock,
    log: env.log,
    config: () => tasks,
    runners: { shell: runShell, wait: runWait, sequence: runSequence },
    defaultRetry: Retry.parse({}),
  });
  return executor;
}

function publish(type: string, payload: unknown = null, correlation_id?: string): EventRecord {
  const r = bus.publish({ type, source: 'test', payload: payload as never, correlation_id });
  if (r.status !== 'inserted') {
    throw new Error('dup');
  }
  return r.event;
}

const events = (): EventRecord[] => env.store.events.listAfter(0, 100);
const runOf = (task: string, trigger: EventRecord): RunRecord | undefined =>
  env.store.runs.getByTaskAndEvent(task, trigger.id);

/** Publishes the trigger, lets the run reach its wait. */
async function askAndSuspend(ex: Executor, type = 'x.ask', task = 'gate'): Promise<EventRecord> {
  const trigger = publish(type, { q: 'ok?' });
  bus.dispatcher.drain();
  await ex.idle();
  expect(runOf(task, trigger)?.status).toBe('waiting');
  return trigger;
}

describe('wait inside a sequence', () => {
  it('suspends the run, frees the worker, resumes on the matching event and finishes', async () => {
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex);
    expect(ex.stats()).toEqual({ pending: 0, in_flight: 0 });
    expect(env.store.waits.get(runOf('gate', trigger)?.id ?? '')).toMatchObject({
      type: 'chat.reply',
      filter: `payload.correlation_id == '${trigger.correlation_id}'`,
      on_timeout: 'fail',
      resume: { step: 1, steps: ['asked ok?'] },
      outcome: null,
    });

    // Another conversation's reply is not ours.
    publish('chat.reply', { correlation_id: 'cor_other', approved: true });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('gate', trigger)?.status).toBe('waiting');

    const reply = publish(
      'chat.reply',
      { correlation_id: trigger.correlation_id, approved: true, text: 'yes' },
      trigger.correlation_id,
    );
    bus.dispatcher.drain();
    await ex.idle();
    const run = runOf('gate', trigger);
    expect(run).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(run?.result).toEqual({
      steps: [
        'asked ok?',
        expect.objectContaining({ id: reply.id, type: 'chat.reply', payload: reply.payload }),
        'pushed after yes (asked ok?)',
      ],
    });
    expect(env.store.waits.get(run?.id ?? '')).toBeUndefined();
    expect(events().filter((e) => e.type.startsWith('task.'))).toMatchObject([
      {
        type: 'task.gate.succeeded',
        parent_id: trigger.id,
        correlation_id: trigger.correlation_id,
      },
    ]);
    expect(env.lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['run.waiting', 'wait.matched', 'run.resumed', 'run.succeeded']),
    );
  });

  it('skips the guarded step when the reply is not an approval', async () => {
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex);
    publish('chat.reply', { correlation_id: trigger.correlation_id, approved: false });
    bus.dispatcher.drain();
    await ex.idle();
    const run = runOf('gate', trigger);
    expect(run?.status).toBe('succeeded');
    expect((run?.result as { steps: unknown[] }).steps[2]).toBeNull();
    expect(env.lines.some((l) => l.msg === 'step.skipped' && l.step === 2)).toBe(true);
  });

  it('fails without retry when the wait times out, or succeeds when configured to', async () => {
    const ex = make();
    ex.start();
    const strict = await askAndSuspend(ex, 'x.ask_short', 'gate_short');
    const lenient = await askAndSuspend(ex, 'x.ask_lenient', 'gate_lenient');
    env.clock.set('2026-09-19T10:00:29.000Z');
    bus.dispatcher.dispatchOnce();
    await ex.idle();
    expect(runOf('gate_short', strict)?.status).toBe('waiting');

    env.clock.set('2026-09-19T10:00:31.000Z');
    bus.dispatcher.dispatchOnce();
    await ex.idle();
    expect(runOf('gate_short', strict)).toMatchObject({
      status: 'failed',
      attempt: 1,
      error: 'timed out waiting for chat.reply',
    });
    expect(runOf('gate_lenient', lenient)).toMatchObject({
      status: 'succeeded',
      result: { steps: ['asked ok?', { timed_out: true }, null] },
    });
    expect(env.lines.filter((l) => l.msg === 'wait.timeout')).toHaveLength(2);
  });

  it('survives a restart while waiting and resumes on the new executor', async () => {
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex);
    await ex.stop();

    const ex2 = make();
    expect(ex2.start()).toEqual({ interrupted: 0, resumed: 0, waiting: 1 });
    expect(runOf('gate', trigger)?.status).toBe('waiting');
    publish('chat.reply', {
      correlation_id: trigger.correlation_id,
      approved: true,
      text: 'late yes',
    });
    bus.dispatcher.drain();
    await ex2.idle();
    expect(runOf('gate', trigger)).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect((runOf('gate', trigger)?.result as { steps: unknown[] }).steps[2]).toBe(
      'pushed after late yes (asked ok?)',
    );
  });

  it('resumes a run whose wait ended while the daemon was down', async () => {
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex);
    await ex.stop();
    // The reply arrives and is dispatched (e.g. by a process that then crashed before resuming).
    publish('chat.reply', { correlation_id: trigger.correlation_id, approved: true, text: 'y' });
    bus.dispatcher.drain();
    expect(runOf('gate', trigger)?.status).toBe('queued');

    const ex2 = make();
    expect(ex2.start()).toMatchObject({ resumed: 1, waiting: 0 });
    await ex2.idle();
    expect(runOf('gate', trigger)?.status).toBe('succeeded');
  });
});

describe('standalone wait', () => {
  it('catches a reply published after the trigger but before the wait was armed', async () => {
    const trigger = publish('x.wait');
    bus.dispatcher.drain(); // queued, but no executor yet
    const early = publish('chat.message', { hello: 1 }, trigger.correlation_id);
    bus.dispatcher.drain(); // dispatched with no wait to match
    const ex = make();
    ex.start();
    await ex.idle();
    const run = runOf('plain_wait', trigger);
    expect(run?.status).toBe('succeeded');
    expect(run?.result).toMatchObject({
      id: early.id,
      type: 'chat.message',
      payload: { hello: 1 },
    });
    expect(env.lines.find((l) => l.msg === 'run.waiting')).toMatchObject({
      matched_event_id: early.id,
    });
  });

  it('matches a type pattern and returns the event as the run result', async () => {
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex, 'x.wait', 'plain_wait');
    const reply = publish('chat.message', { text: 'hi' });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('plain_wait', trigger)?.result).toMatchObject({
      id: reply.id,
      payload: { text: 'hi' },
    });
  });
});
