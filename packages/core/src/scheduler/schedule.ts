import { Cron, CronPattern } from 'croner';

/** Wider than any real daylight-saving shift (Troll station moves by 2 h). */
const SHIFT_WINDOW_MS = 3 * 60 * 60_000;
/** The longest delay `setTimeout` accepts; a later run is waited out in several steps. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A cron schedule's run times. croner runs each wall-clock time once, so in the hour that
 * repeats when clocks go back it skips the second pass. That is right for a fixed-time
 * schedule (`30 2 * * *` runs once), but it opens a gap of an hour or more in a schedule
 * whose hour field matches every hour (every 30 minutes, `@hourly`). For those, `next` also
 * returns the second pass of each match in the repeated hour, so they keep their pace in
 * real time (#98).
 */
export class Schedule {
  private readonly cron: Cron;
  private readonly everyHour: boolean;

  constructor(
    readonly pattern: string,
    readonly tz?: string,
  ) {
    const options = { paused: true, ...(tz === undefined ? {} : { timezone: tz }) };
    this.cron = new Cron(pattern, options);
    this.everyHour = new CronPattern(pattern, tz).hour.every((h) => h === 1);
  }

  /** The first run strictly after `after`, or `null` when the schedule never runs again. */
  next(after: Date): Date | null {
    const from = after.getTime();
    const back = this.clocksBackNear(from);
    if (back === null) {
      return this.cron.nextRun(after);
    }
    const { change, shift } = back;
    let plain: Date | null;
    if (from >= change && from < change + shift) {
      // Asked from inside the second pass, croner answers with a time in the first pass,
      // which is already past. Its next run proper is at or after the repeated hour.
      const end = new Date(change + shift);
      plain = this.cron.match(end) ? end : this.cron.nextRun(end);
    } else {
      plain = this.cron.nextRun(after);
    }
    if (!this.everyHour) {
      return plain;
    }
    // Wall times in [change, change + shift) repeat those in [change - shift, change). A run
    // `r` of the first pass recurs at `r + shift`; it must land after `from`.
    const first = this.cron.nextRun(new Date(Math.max(from - shift, change - shift - 1000)));
    if (first === null || first.getTime() >= change || first.getTime() + shift <= from) {
      return plain;
    }
    const repeat = new Date(first.getTime() + shift);
    return plain !== null && plain.getTime() <= repeat.getTime() ? plain : repeat;
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
    const wait = Math.min(Math.max(next.getTime() - Date.now(), 0), MAX_TIMEOUT_MS);
    timer = setTimeout(fire, wait);
  };

  const fire = (): void => {
    timer = undefined;
    if (next === null) {
      return;
    }
    const now = Date.now();
    if (now < next.getTime()) {
      arm(); // woke early, or a run further away than one timer allows
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
