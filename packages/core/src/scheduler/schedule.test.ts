import { afterEach, describe, expect, it, vi } from 'vitest';

import { armSchedule, Schedule } from './schedule.js';

/** The next `n` fire times after `from`, as ISO strings. */
function runs(schedule: Schedule, from: string, n: number): string[] {
  const out: string[] = [];
  let at: Date | null = new Date(from);
  while (out.length < n) {
    at = schedule.next(at);
    if (at === null) {
      break;
    }
    out.push(at.toISOString());
  }
  return out;
}

// Europe/Prague: 2026-10-25 03:00 CEST (01:00Z) becomes 02:00 CET, so 02:00–02:59 repeats.
// 2026-03-29 02:00 CET (01:00Z) becomes 03:00 CEST, so 02:00–02:59 never happens.
describe('Schedule.next across daylight-saving changes', () => {
  it('keeps an interval schedule running through the repeated hour (#98)', () => {
    const s = new Schedule('*/30 * * * *', 'Europe/Prague');
    expect(runs(s, '2026-10-24T23:45:00Z', 6)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T02:30:00.000Z',
    ]);
  });

  it('runs an hourly schedule every real hour through the repeated hour', () => {
    const s = new Schedule('0 * * * *', 'Europe/Prague');
    expect(runs(s, '2026-10-24T23:30:00Z', 3)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ]);
  });

  it('runs a fixed-time schedule once in the repeated hour', () => {
    expect(runs(new Schedule('30 2 * * *', 'Europe/Prague'), '2026-10-24T12:00:00Z', 2)).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ]);
    // Asked from inside the second pass (02:15 CET), not the first pass's 02:30, now past.
    expect(runs(new Schedule('30 2 * * *', 'Europe/Prague'), '2026-10-25T01:15:00Z', 1)).toEqual([
      '2026-10-26T01:30:00.000Z',
    ]);
    // A step in the hour field is not every hour: the repeated 02:00 runs once.
    expect(runs(new Schedule('0 */2 * * *', 'Europe/Prague'), '2026-10-24T23:30:00Z', 2)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
    ]);
  });

  it('keeps a seconds schedule running through the repeated hour', () => {
    const s = new Schedule('0 */30 * * * *', 'Europe/Prague');
    expect(runs(s, '2026-10-25T00:45:00Z', 2)).toEqual([
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:30:00.000Z',
    ]);
  });

  it('does not repeat an interval schedule on a day without a change', () => {
    const s = new Schedule('*/30 * * * *', 'Europe/Prague');
    expect(runs(s, '2026-10-23T23:45:00Z', 4)).toEqual([
      '2026-10-24T00:00:00.000Z',
      '2026-10-24T00:30:00.000Z',
      '2026-10-24T01:00:00.000Z',
      '2026-10-24T01:30:00.000Z',
    ]);
  });

  it('keeps an interval schedule at its pace across the skipped hour', () => {
    const s = new Schedule('*/30 * * * *', 'Europe/Prague');
    expect(runs(s, '2026-03-29T00:15:00Z', 3)).toEqual([
      '2026-03-29T00:30:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-29T01:30:00.000Z',
    ]);
  });

  it('honours restricted days in the repeated hour', () => {
    // Only Saturdays: Sunday 2026-10-25 has no runs, repeated hour included.
    const s = new Schedule('*/30 * * * 6', 'Europe/Prague');
    expect(runs(s, '2026-10-24T21:15:00Z', 2)).toEqual([
      '2026-10-24T21:30:00.000Z',
      '2026-10-30T23:00:00.000Z',
    ]);
  });

  describe('without tz, in the host zone', () => {
    const tz = process.env.TZ;
    afterEach(() => {
      if (tz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = tz;
      }
    });

    it('keeps an interval schedule running through the repeated hour', () => {
      process.env.TZ = 'Europe/Prague';
      expect(runs(new Schedule('*/30 * * * *'), '2026-10-25T00:45:00Z', 3)).toEqual([
        '2026-10-25T01:00:00.000Z',
        '2026-10-25T01:30:00.000Z',
        '2026-10-25T02:00:00.000Z',
      ]);
    });
  });
});

describe('armSchedule', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires at each run with its time, across the repeated hour, and stops', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T00:10:00Z'));
    const fired: string[] = [];
    const timer = armSchedule(new Schedule('*/30 * * * *', 'Europe/Prague'), {
      onTick: (at) => fired.push(at.toISOString()),
      onError: () => undefined,
    });
    expect(timer.nextRun()?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect(fired).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ]);
    timer.stop();
    expect(timer.nextRun()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a throwing tick and keeps going', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T10:00:30Z'));
    const errors: unknown[] = [];
    let n = 0;
    const timer = armSchedule(new Schedule('* * * * *'), {
      onTick: () => {
        n += 1;
        throw new Error('boom');
      },
      onError: (err) => errors.push(err),
    });
    vi.advanceTimersByTime(2 * 60_000);
    expect(n).toBe(2);
    expect(errors.map((e) => (e as Error).message)).toEqual(['boom', 'boom']);
    timer.stop();
  });

  it('waits out a run further away than one timer allows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fired: string[] = [];
    const timer = armSchedule(new Schedule('0 0 1 6 *', 'UTC'), {
      onTick: (at) => fired.push(at.toISOString()),
      onError: () => undefined,
    });
    vi.advanceTimersByTime(30 * 24 * 60 * 60_000);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(140 * 24 * 60 * 60_000);
    expect(fired).toEqual(['2026-06-01T00:00:00.000Z']);
    timer.stop();
  });
});
