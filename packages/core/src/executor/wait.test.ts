import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSequence } from '../actions/sequence.js';
import { runShell } from '../actions/shell.js';
import { runWait } from '../actions/wait.js';
import { createBus, type EventBus } from '../bus/bus.js';
import { config, testEnv, type TestEnv } from '../bus/testing.js';
import { Retry } from '../config/schema.js';
import type { ConnectorClients } from '../actions/types.js';
import type { EventRecord, JsonValue, RunRecord } from '../store/types.js';
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

const approval =
  "payload.correlation_id == '${event.correlation_id}' && payload.approved == `true`";

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
  {
    name: 'gates',
    trigger: { kind: 'event', type: 'x.gates' },
    action: {
      kind: 'sequence',
      steps: [
        { kind: 'wait', for: { type: 'chat.reply', filter: approval }, timeout: '1h' },
        {
          kind: 'wait',
          for: { type: 'chat.*', filter: approval },
          timeout: '30s',
          on_timeout: 'succeed',
        },
        { kind: 'wait', for: { type: 'chat.reply', filter: approval }, timeout: '1h' },
      ],
    },
  },
  {
    name: 'two_keys',
    trigger: { kind: 'event', type: 'x.two_keys' },
    action: {
      kind: 'sequence',
      steps: [
        { kind: 'wait', for: { type: 'chat.reply', filter: "payload.k == 'a'" }, timeout: '1h' },
        { kind: 'wait', for: { type: 'chat.reply', filter: "payload.k == 'b'" }, timeout: '1h' },
      ],
    },
  },
  {
    name: 'retry_after_wait',
    trigger: { kind: 'event', type: 'x.retry_after_wait' },
    retry: { attempts: 2, backoff: 'fixed', base: '10ms' },
    action: {
      kind: 'sequence',
      steps: [
        { kind: 'wait', for: { type: 'chat.reply', filter: "payload.k == 'a'" }, timeout: '1h' },
        { kind: 'shell', cmd: ['sh', '-c', 'test ${run.attempt} -gt 1'] },
        { kind: 'wait', for: { type: 'chat.reply', filter: "payload.k == 'a'" }, timeout: '1h' },
      ],
    },
  },
  {
    name: 'send_then_fail',
    trigger: { kind: 'event', type: 'x.send_then_fail' },
    retry: { attempts: 2, backoff: 'fixed', base: '10ms' },
    action: {
      kind: 'sequence',
      steps: [
        { kind: 'connector', connector: 'mail', op: 'send', args: { to: 'a@example.org' } },
        { kind: 'shell', cmd: ['sh', '-c', 'test ${run.attempt} -gt 1'] },
        { kind: 'shell', cmd: ['echo', 'sent ${steps[0].id}'] },
      ],
    },
  },
  {
    name: 'send_then_fail_slow',
    trigger: { kind: 'event', type: 'x.send_then_fail_slow' },
    retry: { attempts: 2, backoff: 'fixed', base: '1h' },
    action: {
      kind: 'sequence',
      steps: [
        { kind: 'connector', connector: 'mail', op: 'send', args: { to: 'a@example.org' } },
        { kind: 'shell', cmd: ['sh', '-c', 'test ${run.attempt} -gt 1'] },
      ],
    },
  },
  {
    name: 'poll',
    trigger: { kind: 'event', type: 'x.poll' },
    action: { kind: 'shell', cmd: ['echo', '[{"q":"a"},{"q":"b"}]'], result: 'json_stdout' },
    emit: [{ type: 'x.ask', each: '${result}', payload: '${item}' }],
  },
  {
    name: 'gate_by_name',
    trigger: { kind: 'event', type: 'x.ask_name' },
    action: {
      kind: 'wait',
      for: { type: 'chat.reply', filter: "payload.name == '${event.payload.name}'" },
      timeout: '24h',
    },
  },
]);

let env: TestEnv;
let bus: EventBus;
let executor: Executor | undefined;
/** What the executor and the dispatcher read as the current config; a reload replaces it. */
let current = tasks;
/** Every `send` the fake mail connector took, in order. */
let sent: Record<string, JsonValue>[];

/** A connector whose `send` is not idempotent: each call is one more mail. */
const mail: ConnectorClients = {
  names: () => ['mail'],
  call: (_connector, _op, args) => {
    sent.push(args);
    return Promise.resolve({ id: `msg-${String(sent.length)}` });
  },
};

beforeEach(() => {
  sent = [];
  env = testEnv();
  bus = createBus({ store: env.store, clock: env.clock, log: env.log });
  current = tasks;
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
    config: () => current,
    runners: { shell: runShell, wait: runWait, sequence: runSequence },
    connectors: mail,
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

  it('resumes again after a stop aborts the resumed attempt (#39)', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'oa-wait-')), 'go');
    current = config([
      {
        name: 'gate_slow',
        trigger: { kind: 'event', type: 'x.ask_slow' },
        action: {
          kind: 'sequence',
          steps: [
            { kind: 'wait', for: { type: 'chat.reply' }, timeout: '1h' },
            { kind: 'shell', cmd: ['sh', '-c', `[ -e ${marker} ] || sleep 30; echo done`] },
          ],
        },
      },
    ]);
    bus.dispatcher.setConfig(current);
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex, 'x.ask_slow', 'gate_slow');
    publish('chat.reply', { approved: true });
    bus.dispatcher.drain();
    await vi.waitFor(() => {
      expect(runOf('gate_slow', trigger)?.status).toBe('running');
    });
    await ex.stop();

    writeFileSync(marker, '');
    const ex2 = make();
    expect(ex2.start()).toEqual({ interrupted: 0, resumed: 1, waiting: 0 });
    await ex2.idle();
    expect(runOf('gate_slow', trigger)).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      result: { steps: [{ type: 'chat.reply' }, 'done'] },
    });
    expect(events().some((e) => e.type === 'task.gate_slow.failed')).toBe(false);
  });

  it('lets a stop finish when a run parks during the grace window on a reply already in (#39)', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'oa-wait-')), 'go');
    current = config([
      {
        name: 'ask_then_wait',
        trigger: { kind: 'event', type: 'x.ask_then_wait' },
        action: {
          kind: 'sequence',
          steps: [
            { kind: 'shell', cmd: ['sh', '-c', `while [ ! -e ${marker} ]; do sleep 0.02; done`] },
            { kind: 'wait', for: { type: 'chat.reply' }, timeout: '1h' },
          ],
        },
      },
    ]);
    bus.dispatcher.setConfig(current);
    const ex = make();
    ex.configure({ stopGrace: '5s' });
    ex.start();
    const trigger = publish('x.ask_then_wait');
    bus.dispatcher.drain();
    await vi.waitFor(() => {
      expect(runOf('ask_then_wait', trigger)?.status).toBe('running');
    });
    publish('chat.reply', { approved: true });
    bus.dispatcher.drain();

    const started = Date.now();
    const stopped = ex.stop();
    writeFileSync(marker, '');
    await stopped;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(runOf('ask_then_wait', trigger)?.status).toBe('queued');

    const ex2 = make();
    expect(ex2.start()).toMatchObject({ interrupted: 0, resumed: 1 });
    await ex2.idle();
    expect(runOf('ask_then_wait', trigger)?.status).toBe('succeeded');
  });
});

describe('several waits in one run (#12)', () => {
  it('does not let the reply that ended one wait end a later one', async () => {
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex, 'x.gates', 'gates');
    const approve = (): EventRecord =>
      publish('chat.reply', { correlation_id: trigger.correlation_id, approved: true });

    const first = approve();
    bus.dispatcher.drain();
    await ex.idle();
    // The second wait is armed after the first reply was dispatched and must not take it.
    expect(runOf('gates', trigger)?.status).toBe('waiting');
    expect(env.store.waits.get(runOf('gates', trigger)?.id ?? '')).toMatchObject({
      type: 'chat.*',
      outcome: null,
    });

    // The second wait times out; the third must still not take the first reply.
    env.clock.set('2026-09-19T10:00:31.000Z');
    bus.dispatcher.dispatchOnce();
    await ex.idle();
    expect(runOf('gates', trigger)?.status).toBe('waiting');

    const third = approve();
    bus.dispatcher.drain();
    await ex.idle();
    const run = runOf('gates', trigger);
    expect(run?.status).toBe('succeeded');
    const steps = (run?.result as { steps: { id?: string }[] }).steps;
    expect(steps.map((s) => s.id ?? s)).toEqual([first.id, { timed_out: true }, third.id]);
  });

  it('lets a later wait take an event that arrived while an earlier wait was armed', async () => {
    const ex = make();
    ex.start();
    const trigger = publish('x.two_keys');
    bus.dispatcher.drain();
    await ex.idle();
    const b = publish('chat.reply', { k: 'b' });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('two_keys', trigger)?.status).toBe('waiting');

    const a = publish('chat.reply', { k: 'a' });
    bus.dispatcher.drain();
    await ex.idle();
    const run = runOf('two_keys', trigger);
    expect(run?.status).toBe('succeeded');
    const steps = (run?.result as { steps: { id: string }[] }).steps;
    expect(steps.map((s) => s.id)).toEqual([a.id, b.id]);
  });
});

describe('a retry after a resumed wait (#156)', () => {
  it('does not repeat the resumed step in the step results', async () => {
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex, 'x.retry_after_wait', 'retry_after_wait');

    const first = publish('chat.reply', { k: 'a' });
    bus.dispatcher.drain();
    await ex.idle();
    // Attempt 1 resumes, its shell step fails, and attempt 2 waits at the second wait.
    expect(runOf('retry_after_wait', trigger)?.status).toBe('waiting');

    const second = publish('chat.reply', { k: 'a' });
    bus.dispatcher.drain();
    await ex.idle();
    const run = runOf('retry_after_wait', trigger);
    expect(run?.status).toBe('succeeded');
    const steps = (run?.result as { steps: { id?: string }[] }).steps;
    expect(steps.map((s) => s.id ?? null)).toEqual([first.id, null, second.id]);
  });
});

describe('a retry after a later step failed (#189)', () => {
  it('does not repeat a connector step that already succeeded', async () => {
    const ex = make();
    ex.start();
    const trigger = publish('x.send_then_fail');
    bus.dispatcher.drain();
    await ex.idle();
    const run = runOf('send_then_fail', trigger);
    expect(run?.status).toBe('succeeded');
    expect(run?.attempt).toBe(2);
    expect(sent).toHaveLength(1);
    const steps = (run?.result as { steps: JsonValue[] }).steps;
    expect(steps[0]).toEqual({ id: 'msg-1' });
    expect(steps[2]).toEqual('sent msg-1');
  });

  it('does not repeat it after a restart during the backoff either', async () => {
    const ex = make();
    ex.start();
    const trigger = publish('x.send_then_fail_slow');
    bus.dispatcher.drain();
    await vi.waitFor(() => {
      expect(runOf('send_then_fail_slow', trigger)?.error).not.toBeNull();
    });
    await ex.stop();
    expect(runOf('send_then_fail_slow', trigger)?.status).toBe('running');

    const next = make();
    next.start();
    await next.idle();
    const run = runOf('send_then_fail_slow', trigger);
    expect(run?.status).toBe('succeeded');
    expect(run?.attempt).toBe(2);
    expect(sent).toHaveLength(1);
  });
});

/** Reloads `current` with `task`'s steps replaced. */
function reload(task: string, steps: unknown[]): void {
  current = config(
    tasks.tasks.map((t) =>
      t.name === task ? { ...t.config, action: { kind: 'sequence', steps } } : t.config,
    ),
  );
  bus.dispatcher.setConfig(current);
}

describe('a reload while a run is in flight (#38)', () => {
  it('resumes a waiting run under the steps it started with', async () => {
    const ex = make();
    ex.start();
    const trigger = await askAndSuspend(ex);
    const [ask, ...rest] = gateSteps('1h');
    reload('gate', [ask, { kind: 'shell', cmd: ['echo', 'INSERTED STEP'] }, ...rest]);

    publish('chat.reply', { correlation_id: trigger.correlation_id, approved: true, text: 'y' });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('gate', trigger)).toMatchObject({
      status: 'succeeded',
      result: {
        steps: [
          'asked ok?',
          expect.objectContaining({ type: 'chat.reply' }),
          'pushed after y (asked ok?)',
        ],
      },
    });
  });

  it('retries a recovered run under the steps it started with', async () => {
    const ex = make();
    ex.start();
    const trigger = publish('x.send_then_fail_slow');
    bus.dispatcher.drain();
    await vi.waitFor(() => {
      expect(runOf('send_then_fail_slow', trigger)?.error).not.toBeNull();
    });
    await ex.stop();
    reload('send_then_fail_slow', [{ kind: 'shell', cmd: ['echo', 'INSERTED STEP'] }]);

    const next = make();
    next.start();
    await next.idle();
    expect(runOf('send_then_fail_slow', trigger)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      result: { steps: [{ id: 'msg-1' }, ''] },
    });
    expect(sent).toHaveLength(1);
  });
});

describe('gates opened for items of one fan-out (#13)', () => {
  it('resumes only the gate the reply answers', async () => {
    const ex = make();
    ex.start();
    publish('x.poll');
    bus.dispatcher.drain();
    await ex.idle();
    bus.dispatcher.drain();
    await ex.idle();
    const asks = events().filter((e) => e.type === 'x.ask');
    const [first, second] = asks;
    if (first === undefined || second === undefined) {
      throw new Error('expected two x.ask events');
    }
    expect(runOf('gate', first)?.status).toBe('waiting');
    expect(runOf('gate', second)?.status).toBe('waiting');

    publish('chat.reply', { correlation_id: first.correlation_id, approved: true, text: 'yes' });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('gate', first)?.status).toBe('succeeded');
    expect(runOf('gate', second)?.status).toBe('waiting');
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

describe('a wait keyed on a value from the trigger (GHSA-6xm2-r635-x33f)', () => {
  /** Starts a `gate_by_name` run for `name` and lets it reach its wait. */
  async function askFor(ex: Executor, name: string): Promise<EventRecord> {
    const trigger = publish('x.ask_name', { name });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('gate_by_name', trigger)?.status).toBe('waiting');
    return trigger;
  }

  it('resumes on the reply that carries the same name, apostrophe included', async () => {
    const ex = make();
    ex.start();
    const trigger = await askFor(ex, "O'Brien");

    publish('chat.reply', { name: 'OBrien', approved: true });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('gate_by_name', trigger)?.status).toBe('waiting');

    const reply = publish('chat.reply', { name: "O'Brien", approved: true });
    bus.dispatcher.drain();
    await ex.idle();
    const run = runOf('gate_by_name', trigger);
    expect(run?.status).toBe('succeeded');
    expect(run?.result).toMatchObject({ id: reply.id, payload: reply.payload });
    expect(env.lines.filter((l) => l.msg === 'wait.invalid')).toEqual([]);
  });

  it('keeps waiting when the name is crafted to match everything', async () => {
    const ex = make();
    ex.start();
    const crafted = "x' || 'a' == 'a";
    const legit = await askFor(ex, 'ABC-1');
    const attacker = await askFor(ex, crafted);

    publish('chat.reply', { name: 'someone else', approved: true });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('gate_by_name', attacker)?.status).toBe('waiting');
    expect(runOf('gate_by_name', legit)?.status).toBe('waiting');

    publish('chat.reply', { name: 'ABC-1', approved: true });
    bus.dispatcher.drain();
    await ex.idle();
    expect(runOf('gate_by_name', legit)?.status).toBe('succeeded');
    expect(runOf('gate_by_name', attacker)?.status).toBe('waiting');
  });
});
