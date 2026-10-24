import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActionRunner, ActionRunners } from '../actions/types.js';
import { runWait } from '../actions/wait.js';
import { createBus, type EventBus } from '../bus/bus.js';
import { runTaskManually, TaskPausedError } from '../bus/manual.js';
import { listTasks, pauseTask, resumeTask } from '../bus/pause.js';
import { config, testEnv, type TestEnv } from '../bus/testing.js';
import type { EventRecord, RunRecord } from '../store/types.js';
import { Executor, RunNotActiveError } from './executor.js';

const tasks = config([
  {
    name: 'work',
    trigger: { kind: 'event', type: 'x.work' },
    action: { kind: 'shell', cmd: ['true'] },
  },
  {
    name: 'gate',
    trigger: { kind: 'event', type: 'x.gate' },
    action: { kind: 'wait', for: { type: 'chat.reply' } },
  },
  {
    name: 'flaky',
    trigger: { kind: 'event', type: 'x.flaky' },
    action: { kind: 'shell', cmd: ['true'] },
    retry: { attempts: 3, backoff: 'fixed', base: '1h' },
  },
  {
    name: 'poll',
    trigger: { kind: 'cron', schedule: '* * * * *' },
    action: { kind: 'wait', for: { type: 'chat.reply' } },
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

function make(shell: ActionRunner, workers = 4): Executor {
  const runners: ActionRunners = { shell, wait: runWait };
  executor = new Executor({
    store: env.store,
    bus,
    clock: env.clock,
    log: env.log,
    config: () => tasks,
    runners,
    workers,
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

/** Publishes and dispatches one event; returns the run it started for `task`. */
function trigger(type: string, task: string, payload: unknown = null): RunRecord {
  const event = publish(type, payload);
  bus.dispatcher.drain();
  const run = env.store.runs.getByTaskAndEvent(task, event.id);
  if (run === undefined) {
    throw new Error(`no run of ${task}`);
  }
  return run;
}

const status = (id: string): RunRecord['status'] | undefined => env.store.runs.getById(id)?.status;
const cancelledEvents = (): EventRecord[] =>
  env.store.events.listAfter(0, 100).filter((e) => e.type.endsWith('.cancelled'));

/** A runner that settles only when its signal aborts. */
const hanging: ActionRunner = (_action, ctx) =>
  new Promise((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => {
      reject(ctx.signal.reason as Error);
    });
  });

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Executor.cancel', () => {
  it('aborts a running run, ends it cancelled and publishes task.<name>.cancelled', async () => {
    const ex = make(hanging);
    const run = trigger('x.work', 'work');
    await until(() => status(run.id) === 'running');

    const after = await ex.cancel(run.id);
    expect(after).toMatchObject({ status: 'cancelled', error: 'cancelled on request', attempt: 1 });
    expect(after?.finished_at).not.toBeNull();
    expect(cancelledEvents()).toMatchObject([
      {
        type: 'task.work.cancelled',
        source: 'task:work',
        parent_id: run.event_id,
        payload: { run_id: run.id, task: 'work', previous_status: 'running', attempt: 1 },
      },
    ]);
    expect(env.store.runs.config(run.id)).toBeUndefined();
    expect(env.lines.filter((l) => l.msg === 'run.cancelled')).toMatchObject([
      { run_id: run.id, previous_status: 'running' },
    ]);
    expect(ex.stats()).toEqual({ pending: 0, in_flight: 0 });
  });

  it('drops a queued run before it starts, and the worker goes to the next run', async () => {
    let calls = 0;
    const ex = make((action, ctx) => {
      calls++;
      return hanging(action, ctx);
    }, 1);
    const first = trigger('x.work', 'work');
    const second = trigger('x.work', 'work');
    await until(() => status(first.id) === 'running');
    expect(status(second.id)).toBe('queued');

    expect(await ex.cancel(second.id)).toMatchObject({ status: 'cancelled', attempt: 0 });
    expect(ex.stats().pending).toBe(0);
    await ex.cancel(first.id);
    await ex.idle();
    expect(calls).toBe(1);
    expect(
      cancelledEvents().map((e) => (e.payload as { previous_status: string }).previous_status),
    ).toEqual(['queued', 'running']);
  });

  it('ends a waiting run: its wait is gone and a matching event no longer resumes it', async () => {
    const ex = make(hanging);
    const run = trigger('x.gate', 'gate');
    await until(() => status(run.id) === 'waiting');

    expect(await ex.cancel(run.id)).toMatchObject({ status: 'cancelled' });
    expect(env.store.waits.get(run.id)).toBeUndefined();
    publish('chat.reply');
    bus.dispatcher.drain();
    await ex.idle();
    expect(status(run.id)).toBe('cancelled');
    expect(cancelledEvents()).toHaveLength(1);
  });

  it('ends a run waiting out a retry backoff', async () => {
    const ex = make(() => Promise.reject(new Error('flake')));
    const run = trigger('x.flaky', 'flaky');
    await until(() => env.lines.some((l) => l.msg === 'run.retry'));

    expect(await ex.cancel(run.id)).toMatchObject({
      status: 'cancelled',
      attempt: 1,
      error: 'cancelled on request',
    });
    expect(ex.stats()).toEqual({ pending: 0, in_flight: 0 });
  });

  it('cancels a run that parks in a wait after the abort', async () => {
    const ex = make((_action, ctx) => {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          ctx.suspend({ type: 'chat.reply', on_timeout: 'fail' }, null).catch(reject);
        });
      });
    });
    const run = trigger('x.work', 'work');
    await until(() => status(run.id) === 'running');

    expect(await ex.cancel(run.id)).toMatchObject({ status: 'cancelled' });
    expect(env.store.waits.get(run.id)).toBeUndefined();
  });

  it('answers with the run still running when its action ignores the abort, and lets it finish', async () => {
    let finish: (v: string) => void = () => undefined;
    const ex = make(() => new Promise((resolve) => (finish = resolve)));
    const run = trigger('x.work', 'work');
    await until(() => status(run.id) === 'running');

    expect(await ex.cancel(run.id, 20)).toMatchObject({ status: 'running' });
    finish('done anyway');
    await ex.idle();
    // It finished before it noticed the cancel: it ends as it finished.
    expect(env.store.runs.getById(run.id)).toMatchObject({
      status: 'succeeded',
      result: 'done anyway',
    });
  });

  it('cancels a run left running by a stop, without an executor slot', async () => {
    const ex = make(hanging);
    const run = trigger('x.work', 'work');
    await until(() => status(run.id) === 'running');
    await ex.stop();
    expect(status(run.id)).toBe('running');

    expect(await ex.cancel(run.id)).toMatchObject({ status: 'cancelled' });
  });

  it('refuses a finished run and returns undefined for an unknown one', async () => {
    const ex = make(() => Promise.resolve('ok'));
    const run = trigger('x.work', 'work');
    await ex.idle();
    await expect(ex.cancel(run.id)).rejects.toThrow(RunNotActiveError);
    await expect(ex.cancel(run.id)).rejects.toThrow(/is already succeeded/);
    expect(await ex.cancel('run_nope')).toBeUndefined();
  });

  it('frees a cron task blocked by overlap: skip once its run is cancelled', async () => {
    const ex = make(hanging);
    const first = trigger('cron.tick', 'poll', { task: 'poll' });
    await until(() => status(first.id) === 'waiting');
    publish('cron.tick', { task: 'poll' });
    bus.dispatcher.drain();
    expect(env.lines.filter((l) => l.msg === 'cron.skipped_overlap')).toHaveLength(1);

    await ex.cancel(first.id);
    const second = trigger('cron.tick', 'poll', { task: 'poll' });
    expect(second.id).not.toBe(first.id);
    await until(() => status(second.id) === 'waiting');
  });
});

describe('paused tasks', () => {
  it('start no run from any event, refuse a manual run, and start again once resumed', async () => {
    const ex = make(() => Promise.resolve('ok'));
    expect(pauseTask(env.store, tasks, env.clock, env.log, 'work')).toEqual({
      name: 'work',
      trigger: 'event',
      paused_at: '2026-09-19T10:00:00.000Z',
    });
    env.clock.set('2026-09-19T11:00:00.000Z');
    // A second pause keeps the first time.
    expect(pauseTask(env.store, tasks, env.clock, env.log, 'work').paused_at).toBe(
      '2026-09-19T10:00:00.000Z',
    );

    const skipped = publish('x.work');
    bus.dispatcher.drain();
    expect(env.store.runs.list({ task: 'work' })).toEqual([]);
    expect(env.lines.filter((l) => l.msg === 'task.skipped_paused')).toMatchObject([
      { task: 'work', event_id: skipped.id },
    ]);
    expect(() => runTaskManually(bus, env.store, tasks, 'work')).toThrow(TaskPausedError);
    expect(listTasks(env.store, tasks).map((t) => [t.name, t.paused_at !== null])).toEqual([
      ['work', true],
      ['gate', false],
      ['flaky', false],
      ['poll', false],
    ]);

    expect(resumeTask(env.store, tasks, env.log, 'work').paused_at).toBeNull();
    const run = trigger('x.work', 'work');
    await ex.idle();
    expect(status(run.id)).toBe('succeeded');
    // The event skipped while paused is not replayed.
    expect(env.store.runs.getByTaskAndEvent('work', skipped.id)).toBeUndefined();
  });

  it('still lets a waiting run of a paused task resume', async () => {
    const ex = make(hanging);
    const run = trigger('x.gate', 'gate');
    await until(() => status(run.id) === 'waiting');
    pauseTask(env.store, tasks, env.clock, env.log, 'gate');

    publish('chat.reply');
    bus.dispatcher.drain();
    await ex.idle();
    expect(status(run.id)).toBe('succeeded');
  });

  it('throws for an unknown task', () => {
    expect(() => pauseTask(env.store, tasks, env.clock, env.log, 'nope')).toThrow(/unknown task/);
    expect(() => resumeTask(env.store, tasks, env.log, 'nope')).toThrow(/unknown task/);
  });
});
