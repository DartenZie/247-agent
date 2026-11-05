import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBus, type EventBus } from '../bus/bus.js';
import { config, shell, testEnv, type TestEnv } from '../bus/testing.js';
import { Metrics } from '../metrics.js';
import { CronScheduler, makeTickEvent } from './cron.js';

let env: TestEnv;
let bus: EventBus;
let scheduler: CronScheduler;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-19T10:00:30.000Z'));
  env = testEnv();
  const clock = { now: () => new Date() };
  bus = createBus({ store: env.store, clock, log: env.log });
  scheduler = new CronScheduler({ bus, log: env.log });
});

afterEach(() => {
  scheduler.stop();
  bus.dispatcher.stop();
  env.close();
  vi.useRealTimers();
});

const every = (name: string, schedule: string, over: Record<string, unknown> = {}) => ({
  name,
  trigger: { kind: 'cron', schedule, ...over },
  action: shell,
});

describe('makeTickEvent', () => {
  it('builds a deduplicated tick event', () => {
    expect(makeTickEvent('poll', new Date('2026-09-19T10:02:00.000Z'))).toEqual({
      type: 'cron.tick',
      source: 'scheduler',
      dedup_key: 'cron:poll:2026-09-19T10:02:00.000Z',
      payload: { task: 'poll', scheduled_at: '2026-09-19T10:02:00.000Z' },
    });
  });

  it('stamps a late tick with the time it was scheduled for', () => {
    scheduler.start(config([every('poll', '* * * * *')]));
    // The process stalls past the 10:01 boundary; the timer still wakes 30 s after it was armed.
    vi.setSystemTime(new Date('2026-09-19T10:02:30.000Z'));
    vi.advanceTimersByTime(30_000);
    expect(env.store.events.listAfter(0, 10).map((e) => e.payload)).toEqual([
      { task: 'poll', scheduled_at: '2026-09-19T10:01:00.000Z' },
    ]);
  });
});

describe('CronScheduler', () => {
  it('publishes one tick per boundary and queues a run through the dispatcher', () => {
    const tasks = config([
      every('poll', '* * * * *'),
      { name: 'm', trigger: { kind: 'manual' }, action: shell },
    ]);
    bus.dispatcher.setConfig(tasks);
    scheduler.start(tasks);
    expect(scheduler.list()).toEqual([
      { task: 'poll', schedule: '* * * * *', nextRun: new Date('2026-09-19T10:01:00.000Z') },
    ]);

    vi.advanceTimersByTime(3 * 60_000);
    const ticks = env.store.events.listAfter(0, 10);
    expect(ticks.map((e) => e.payload)).toEqual([
      { task: 'poll', scheduled_at: '2026-09-19T10:01:00.000Z' },
      { task: 'poll', scheduled_at: '2026-09-19T10:02:00.000Z' },
      { task: 'poll', scheduled_at: '2026-09-19T10:03:00.000Z' },
    ]);
    // The first tick's run is still queued, so the next two were skipped by overlap policy.
    expect(env.store.runs.listByStatus('queued').map((r) => r.event_id)).toEqual([ticks[0]?.id]);
    expect(env.lines.filter((l) => l.msg === 'cron.skipped_overlap')).toHaveLength(2);
  });

  it('collapses a duplicate tick for the same boundary', () => {
    const tasks = config([every('poll', '* * * * *')]);
    scheduler.start(tasks);
    vi.advanceTimersByTime(60_000);
    // A second job for the same boundary (restart inside the minute) publishes the same key.
    const r = bus.publish(makeTickEvent('poll', new Date('2026-09-19T10:01:00.000Z')));
    expect(r.status).toBe('duplicate');
    expect(env.store.events.listAfter(0, 10)).toHaveLength(1);
  });

  it('ticks every 30 minutes through the hour that repeats when clocks go back (#98)', () => {
    vi.setSystemTime(new Date('2026-10-24T23:50:00.000Z'));
    const tasks = config([every('poll', '*/30 * * * *', { tz: 'Europe/Prague' })]);
    scheduler.start(tasks);
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect(env.store.events.listAfter(0, 10).map((e) => e.payload)).toEqual(
      [
        '2026-10-25T00:00:00.000Z',
        '2026-10-25T00:30:00.000Z',
        '2026-10-25T01:00:00.000Z',
        '2026-10-25T01:30:00.000Z',
      ].map((scheduled_at) => ({ task: 'poll', scheduled_at })),
    );
  });

  it('reload replaces changed schedules and stop leaves no timers', () => {
    scheduler.start(config([every('a', '* * * * *'), every('b', '0 * * * *')]));
    expect(scheduler.list().map((j) => j.task)).toEqual(['a', 'b']);

    scheduler.reload(
      config([every('a', '*/2 * * * *'), every('c', '0 9 * * *', { tz: 'Europe/Prague' })]),
    );
    expect(scheduler.list()).toEqual([
      { task: 'a', schedule: '*/2 * * * *', nextRun: new Date('2026-09-19T10:02:00.000Z') },
      { task: 'c', schedule: '0 9 * * *', nextRun: new Date('2026-09-20T07:00:00.000Z') },
    ]);

    vi.advanceTimersByTime(60_000);
    expect(env.store.events.listAfter(0, 10)).toEqual([]); // old every-minute job for `a` is gone
    vi.advanceTimersByTime(60_000);
    expect(env.store.events.listAfter(0, 10).map((e) => e.payload)).toEqual([
      { task: 'a', scheduled_at: '2026-09-19T10:02:00.000Z' },
    ]);

    scheduler.stop();
    bus.dispatcher.stop();
    vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.list()).toEqual([]);
  });
});

describe('ticks missed while the daemon was down (#99)', () => {
  const nightly = (over: Record<string, unknown> = {}) =>
    config([every('backup', '0 3 * * *', { tz: 'UTC', ...over })]);

  /** Stops the daemon's scheduler, lets the clock jump to `at`, and starts a new one. */
  const restartAt = (at: string, tasks: ReturnType<typeof config>): void => {
    scheduler.stop();
    vi.setSystemTime(new Date(at));
    scheduler = new CronScheduler({ bus, log: env.log, cursors: env.store.cursors });
    scheduler.start(tasks, { checkMissed: true });
  };

  const events = () => env.store.events.listAfter(0, 50).map((e) => [e.type, e.payload]);

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-19T02:59:00.000Z'));
    scheduler = new CronScheduler({ bus, log: env.log, cursors: env.store.cursors });
  });

  it('skips a missed tick by default but announces it with cron.missed and a warning', () => {
    const tasks = nightly();
    bus.dispatcher.setConfig(tasks);
    scheduler.start(tasks, { checkMissed: true });
    restartAt('2026-09-19T03:05:00.000Z', tasks);

    expect(events()).toEqual([
      [
        'cron.missed',
        {
          task: 'backup',
          missed: 1,
          first_missed: '2026-09-19T03:00:00.000Z',
          last_missed: '2026-09-19T03:00:00.000Z',
          run: false,
        },
      ],
    ]);
    const missed = env.store.events.listAfter(0, 1)[0];
    expect(missed?.source).toBe('scheduler');
    expect(missed?.dedup_key).toBe('cron.missed:backup:2026-09-19T03:00:00.000Z');
    expect(env.lines.filter((l) => l.msg === 'cron.missed')).toEqual([
      expect.objectContaining({ level: 'warn', task: 'backup', missed: 1 }),
    ]);
    bus.dispatcher.drain();
    expect(env.store.runs.listByStatus('queued')).toEqual([]);
  });

  it('with missed: run_once runs once for several missed ticks, as the last of them', () => {
    const tasks = nightly({ missed: 'run_once' });
    bus.dispatcher.setConfig(tasks);
    scheduler.start(tasks, { checkMissed: true });
    restartAt('2026-09-21T12:00:00.000Z', tasks);

    expect(events()).toEqual([
      [
        'cron.missed',
        {
          task: 'backup',
          missed: 3,
          first_missed: '2026-09-19T03:00:00.000Z',
          last_missed: '2026-09-21T03:00:00.000Z',
          run: true,
        },
      ],
      ['cron.tick', { task: 'backup', scheduled_at: '2026-09-21T03:00:00.000Z', catch_up: true }],
    ]);
    bus.dispatcher.drain();
    const tick = env.store.events.listAfter(0, 50)[1];
    expect(env.store.runs.listByStatus('queued').map((r) => r.event_id)).toEqual([tick?.id]);
  });

  it('reports nothing when no tick fell inside the outage', () => {
    const tasks = nightly({ missed: 'run_once' });
    scheduler.start(tasks, { checkMissed: true });
    vi.setSystemTime(new Date('2026-09-19T03:00:00.000Z'));
    vi.advanceTimersByTime(30_000); // the 03:00 tick fires while the daemon is up
    restartAt('2026-09-20T02:00:00.000Z', tasks);
    expect(events().map(([type]) => type)).toEqual(['cron.tick']);
  });

  it('reports nothing on the first start, for a new task, or on a reload', () => {
    scheduler.start(nightly({ missed: 'run_once' }), { checkMissed: true });
    // `other` joins on a reload; nothing was ever scheduled for it before.
    vi.setSystemTime(new Date('2026-09-25T10:00:00.000Z'));
    scheduler.reload(
      config([
        every('backup', '0 3 * * *', { tz: 'UTC', missed: 'run_once' }),
        every('other', '0 3 * * *', { tz: 'UTC', missed: 'run_once' }),
      ]),
    );
    expect(events()).toEqual([]);
  });

  it('does not count the time a task was absent from the config as missed', () => {
    const tasks = nightly({ missed: 'run_once' });
    scheduler.start(tasks, { checkMissed: true });
    vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
    scheduler.reload(config([every('m', '0 4 * * *', { tz: 'UTC' })])); // backup removed
    vi.setSystemTime(new Date('2026-09-25T10:00:00.000Z'));
    scheduler.reload(tasks); // backup back, while the daemon is up
    restartAt('2026-09-25T11:00:00.000Z', tasks);
    expect(events()).toEqual([]);
  });

  it('counts at most 1000 missed ticks but still catches up on the latest one', () => {
    const tasks = config([every('poll', '* * * * *', { tz: 'UTC', missed: 'run_once' })]);
    scheduler.start(tasks, { checkMissed: true });
    restartAt('2026-09-21T02:59:00.000Z', tasks);
    expect(events()).toEqual([
      [
        'cron.missed',
        {
          task: 'poll',
          missed: 1000,
          first_missed: '2026-09-19T03:00:00.000Z',
          last_missed: '2026-09-21T02:59:00.000Z',
          run: true,
        },
      ],
      ['cron.tick', { task: 'poll', scheduled_at: '2026-09-21T02:59:00.000Z', catch_up: true }],
    ]);
  });

  it('forgets a task removed across a restart, so adding it back later reports nothing', () => {
    const tasks = nightly({ missed: 'run_once' });
    scheduler.start(tasks, { checkMissed: true });
    restartAt('2026-09-19T10:00:00.000Z', config([every('m', '0 4 * * *', { tz: 'UTC' })]));
    const before = events().length;
    restartAt('2026-09-25T10:00:00.000Z', tasks);
    expect(
      events()
        .slice(before)
        .filter(([, p]) => (p as { task: string }).task === 'backup'),
    ).toEqual([]);
  });

  it('counts the catch-up tick and the missed ticks in the metrics', () => {
    const metrics = new Metrics();
    const tasks = nightly({ missed: 'run_once' });
    scheduler.start(tasks, { checkMissed: true });
    scheduler.stop();
    vi.setSystemTime(new Date('2026-09-21T12:00:00.000Z'));
    scheduler = new CronScheduler({ bus, log: env.log, metrics, cursors: env.store.cursors });
    scheduler.start(tasks, { checkMissed: true });
    const text = metrics.render();
    expect(text).toContain('oa_cron_missed_ticks_total{task="backup"} 3');
    expect(text).toContain('oa_cron_ticks_total{task="backup"} 1');
  });
});
