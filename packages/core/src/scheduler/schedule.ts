import { Cron, CronPattern } from 'croner';

/** Wider than any real daylight-saving shift (Troll station moves by 2 h). */
const SHIFT_WINDOW_MS = 3 * 60 * 60_000;
/**
 * The longest single wait. Timers run on a monotonic clock, so a wall clock that is
 * stepped (NTP after boot, a resumed VM) is noticed at the next wake-up, as croner does.
 */
const MAX_WAIT_MS = 30_000;

/**
 * A cron schedule's run times, on top of croner. Near the instant the clocks go back,
 * croner maps each ambiguous wall time to one of its two instants, which one depending on
 * the zone, and asked from inside the repeated hour it can answer with a time already
 * past. So around that instant `next` scans the instants itself and asks croner only
 * whether each one matches. A schedule whose hour field matches every hour (every 30
 * minutes, `@hourly`) runs in both passes of the repeated hour and keeps its pace in real
 * time (#98). Any other schedule (`30 2 * * *`) runs in the first pass only, once.
 */
export class Schedule {
  private readonly cron: Cron;
  private readonly everyHour: boolean;
  /** The step of the scan: a second for 6- and 7-field patterns, else a minute. */
  private readonly unit: number;

  constructor(
    readonly pattern: string,
    readonly tz?: string,
  ) {
    const options = { paused: true, ...(tz === undefined ? {} : { timezone: tz }) };
    this.cron = new Cron(pattern, options);
    const parsed = new CronPattern(pattern, tz);
    this.everyHour = parsed.hour.every((h) => h === 1);
    this.unit = parsed.pattern.split(' ').length >= 6 ? 1000 : 60_000;
  }

  /** The first run strictly after `after`, or `null` when the schedule never runs again. */
  next(after: Date): Date | null {
    const from = after.getTime();
    const plain = this.cron.nextRun(after);
    const back =
      this.clocksBackNear(from) ?? (plain === null ? null : this.clocksBackNear(plain.getTime()));
    if (back === null) {
      return plain;
    }
    // Wall times in [change, end) repeat those in [start, change).
    const start = back.change - back.shift;
    const end = back.change + back.shift;
    if (from >= end || (plain !== null && plain.getTime() < start)) {
      return plain; // croner is exact away from the ambiguous wall times
    }
    const first = Math.ceil(Math.max(from + 1, start) / this.unit) * this.unit;
    for (let t = first; t < end; t += this.unit) {
      const at = new Date(t);
      if ((t < back.change || this.everyHour) && this.cron.match(at)) {
        return at;
      }
    }
    // The wall time at `end` is past the repeated ones, so croner is exact from there.
    const endAt = new Date(end);
    return this.cron.match(endAt) ? endAt : this.cron.nextRun(endAt);
  }

  /** When clocks go back within a few hours of `from`: the instant and by how much. */
  private clocksBackNear(from: number): { change: number; shift: number } | null {
    let lo = from - SHIFT_WINDOW_MS;
    let hi = from + SHIFT_WINDOW_MS;
    const before = offsetMs(lo, this.tz);
    const shift = before - offsetMs(hi, this.tz);
    if (shift <= 0) {
      return null;
    }
    // The instant the offset drops, to the second.
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (offsetMs(mid, this.tz) === before) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return { change: hi, shift };
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at `at`, in ms; the host zone when `tz` is undefined. */
function offsetMs(at: number, tz: string | undefined): number {
  if (tz === undefined) {
    return -new Date(at).getTimezoneOffset() * 60_000;
  }
  let fmt = formatters.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, fmt);
  }
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(at)) {
    p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    p.year ?? 0,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
  return wall - Math.floor(at / 1000) * 1000;
}

export interface ScheduleTimer {
  /** When the schedule fires next; `null` once stopped or when it never runs again. */
  nextRun(): Date | null;
  stop(): void;
}

export interface ScheduleHandlers {
  /** Called at each run with the run's scheduled time. */
  onTick: (at: Date) => void;
  /** Called when `onTick` throws; the schedule keeps running. */
  onError: (err: unknown) => void;
}

/**
 * Fires `onTick` at each run of `schedule`, from now on. A run missed while the process
 * was stalled is not replayed: after a tick, the next run is the first one after now.
 */
export function armSchedule(schedule: Schedule, handlers: ScheduleHandlers): ScheduleTimer {
  let next = schedule.next(new Date());
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    if (next === null) {
      return;
    }
    const wait = Math.min(Math.max(next.getTime() - Date.now(), 0), MAX_WAIT_MS);
    timer = setTimeout(fire, wait);
  };

  const fire = (): void => {
    timer = undefined;
    if (next === null) {
      return;
    }
    const now = Date.now();
    if (now < next.getTime()) {
      arm(); // woke early, or a run further away than one wait
      return;
    }
    const at = next;
    next = schedule.next(new Date(Math.max(at.getTime(), now)));
    try {
      handlers.onTick(at);
    } catch (err) {
      handlers.onError(err);
    }
    arm();
  };

  arm();
  return {
    nextRun: () => next,
    stop: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      next = null;
    },
  };
}
