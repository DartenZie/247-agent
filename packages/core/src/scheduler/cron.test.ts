import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBus, type EventBus } from '../bus/bus.js';
import { config, shell, testEnv, type TestEnv } from '../bus/testing.js';
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
