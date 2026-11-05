import type { EventBus } from '../bus/bus.js';
import { CRON_MISSED, CRON_TICK, type CompiledConfig, type CompiledTask } from '../bus/matcher.js';
import { errorMessage } from '../errors.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
import type { CursorStore } from '../store/cursors.js';
import type { NewEvent } from '../store/types.js';
import { armSchedule, Schedule, type ScheduleTimer } from './schedule.js';

export interface SchedulerOptions {
  bus: EventBus;
  log: Logger;
  metrics?: Metrics | undefined;
  /** Where each task's last accounted-for instant is kept, to find ticks missed while down. */
  cursors?: Pick<CursorStore, 'get' | 'set' | 'names' | 'delete'> | undefined;
}

export interface StartOptions {
  /** At daemon startup: report (and with `missed: run_once`, run) ticks missed while down. */
  checkMissed?: boolean;
}

/** Missed ticks counted per task and outage; past this, the count stops. */
export const MAX_MISSED = 1000;

export interface ScheduledJob {
  task: string;
  schedule: string;
  nextRun: Date | null;
}

/** The event a cron tick publishes. Deduplicated per (task, boundary). */
export function makeTickEvent(task: string, scheduledAt: Date, catchUp = false): NewEvent {
  const iso = scheduledAt.toISOString();
  return {
    type: CRON_TICK,
    source: 'scheduler',
    dedup_key: `cron:${task}:${iso}`,
    payload: catchUp ? { task, scheduled_at: iso, catch_up: true } : { task, scheduled_at: iso },
  };
}

/** The cursor holding the instant up to which the task's ticks are accounted for. */
const CURSOR_PREFIX = 'cron:';
const cursorName = (task: string): string => `${CURSOR_PREFIX}${task}`;

/**
 * One schedule timer per cron task (see `schedule.ts`). Each tick publishes a `cron.tick` event; the dispatcher
 * decides whether to queue a run (see `overlap`). Each tick, and each arming, moves the
 * task's cursor to that instant; at startup the boundaries between the cursor and now are
 * the ticks missed while the daemon was down. They publish one `cron.missed` event and,
 * with `missed: run_once`, one `cron.tick` for the last of them (#99).
 */
export class CronScheduler {
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private readonly cursors: Pick<CursorStore, 'get' | 'set' | 'names' | 'delete'> | undefined;
  private jobs = new Map<string, { job: ScheduleTimer; schedule: string }>();

  constructor(opts: SchedulerOptions) {
    this.bus = opts.bus;
    this.log = opts.log;
    this.metrics = opts.metrics ?? new Metrics();
    this.cursors = opts.cursors;
  }

  start(config: CompiledConfig, opts: StartOptions = {}): void {
    this.stop();
    const armed = new Set<string>();
    for (const task of config.tasks) {
      if (task.kind === 'cron') {
        // A failed check keeps the cursor, so the next start reports the miss again.
        const keepCursor = opts.checkMissed === true && !this.checkMissed(task);
        this.arm(task, !keepCursor);
        armed.add(cursorName(task.name));
      }
    }
    // A task that comes back later starts afresh instead of counting its absence as missed.
    for (const name of this.cursors?.names(CURSOR_PREFIX) ?? []) {
      if (!armed.has(name)) {
        this.cursors?.delete(name);
      }
    }
  }

  /** Cron times are absolute, so a reload is simply stop-all + start-all. */
  reload(config: CompiledConfig): void {
    this.start(config);
  }

  stop(): void {
    for (const { job } of this.jobs.values()) {
      job.stop();
    }
    this.jobs = new Map();
  }

  list(): ScheduledJob[] {
    return [...this.jobs.entries()].map(([task, { job, schedule }]) => ({
      task,
      schedule,
      nextRun: job.nextRun(),
    }));
  }

  /** When the task's job fires next; `null` when the task has no armed job. */
  nextRun(task: string): Date | null {
    return this.jobs.get(task)?.job.nextRun() ?? null;
  }

  private arm(task: CompiledTask, moveCursor = true): void {
    const trigger = task.config.trigger;
    if (trigger.kind !== 'cron') {
      return;
    }
    const { schedule } = trigger;
    if (moveCursor) {
      this.cursors?.set(cursorName(task.name), Date.now());
    }
    const job = armSchedule(new Schedule(schedule, trigger.tz), {
      onTick: (at) => {
        this.cursors?.set(cursorName(task.name), at.getTime());
        const result = this.bus.publish(makeTickEvent(task.name, at));
        this.metrics.cronTicks.inc({ task: task.name });
        this.log.debug(result.status === 'inserted' ? 'cron.tick' : 'cron.tick_duplicate', {
          task: task.name,
          scheduled_at: at.toISOString(),
        });
      },
      onError: (err: unknown) => {
        this.log.error('cron.tick_failed', {
          task: task.name,
          error: errorMessage(err),
        });
      },
    });
    this.jobs.set(task.name, { job, schedule });
    this.log.info('cron.armed', {
      task: task.name,
      schedule,
      next_run: job.nextRun()?.toISOString() ?? null,
    });
  }

  /**
   * Publishes `cron.missed` (and a catch-up tick) for boundaries in (cursor, now]. Counts at
   * most `MAX_MISSED` of them, but `last_missed` is always the latest. False when publishing failed.
   */
  private checkMissed(task: CompiledTask): boolean {
    const trigger = task.config.trigger;
    const since = this.cursors?.get(cursorName(task.name)) ?? 0;
    if (trigger.kind !== 'cron' || since <= 0) {
      return true; // first start, or a task never armed before
    }
    const now = Date.now();
    const schedule = new Schedule(trigger.schedule, trigger.tz);
    let first: Date | null = null;
    let last: Date | null = null;
    let missed = 0;
    for (
      let at = schedule.next(new Date(since));
      at !== null && at.getTime() <= now && missed < MAX_MISSED;
      at = schedule.next(at)
    ) {
      first ??= at;
      last = at;
      missed += 1;
    }
    if (first === null || last === null) {
      return true;
    }
    if (missed === MAX_MISSED) {
      last = lastAtOrBefore(schedule, now, last);
    }
    const run = trigger.missed === 'run_once';
    const fields = {
      task: task.name,
      missed,
      first_missed: first.toISOString(),
      last_missed: last.toISOString(),
      run,
    };
    try {
      this.bus.publish({
        type: CRON_MISSED,
        source: 'scheduler',
        dedup_key: `cron.missed:${task.name}:${fields.first_missed}`,
        payload: fields,
      });
      this.metrics.cronMissedTicks.inc({ task: task.name }, missed);
      this.log.warn('cron.missed', fields);
      if (run) {
        this.bus.publish(makeTickEvent(task.name, last, true));
        this.metrics.cronTicks.inc({ task: task.name });
      }
    } catch (err) {
      this.log.error('cron.missed_failed', {
        task: task.name,
        error: errorMessage(err),
      });
      return false;
    }
    return true;
  }
}

/**
 * The schedule's latest boundary at or before `now`, given one (`known`) that is. A binary
 * search over (known, now]: about 40 steps whatever the schedule and the outage.
 */
function lastAtOrBefore(schedule: Schedule, now: number, known: Date): Date {
  let last = known;
  let hi = now;
  for (;;) {
    const next = schedule.next(last);
    if (next === null || next.getTime() > now) {
      return last;
    }
    const mid = new Date(Math.floor((last.getTime() + hi) / 2));
    const at = schedule.next(mid);
    if (at !== null && at.getTime() <= now) {
      last = at;
    } else {
      hi = mid.getTime();
    }
  }
}
