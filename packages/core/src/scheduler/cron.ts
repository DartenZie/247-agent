import { Cron, CronPattern, type CronOptions } from 'croner';

import type { EventBus } from '../bus/bus.js';
import { CRON_TICK, type CompiledConfig, type CompiledTask } from '../bus/matcher.js';
import type { Clock } from '../clock.js';
import type { Logger } from '../log.js';
import type { NewEvent } from '../store/types.js';

export interface SchedulerOptions {
  bus: EventBus;
  clock: Clock;
  log: Logger;
}

export interface ScheduledJob {
  task: string;
  schedule: string;
  nextRun: Date | null;
}

/** The event a cron tick publishes. Deduplicated per (task, boundary). */
export function makeTickEvent(task: string, scheduledAt: Date): NewEvent {
  const iso = scheduledAt.toISOString();
  return {
    type: CRON_TICK,
    source: 'scheduler',
    dedup_key: `cron:${task}:${iso}`,
    payload: { task, scheduled_at: iso },
  };
}

/** Floors `now` to the boundary the pattern fires on: seconds for 6/7-field, else minutes. */
export function floorToBoundary(now: Date, schedule: string): Date {
  const fields = new CronPattern(schedule).pattern.split(' ').length;
  const unit = fields >= 6 ? 1000 : 60_000;
  return new Date(Math.floor(now.getTime() / unit) * unit);
}

/**
 * One croner job per cron task. Each tick publishes a `cron.tick` event; the dispatcher
 * decides whether to queue a run (see `overlap`). Missed ticks while the daemon was down
 * are not replayed.
 */
export class CronScheduler {
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly log: Logger;
  private jobs = new Map<string, { job: Cron; schedule: string }>();

  constructor(opts: SchedulerOptions) {
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.log = opts.log;
  }

  start(config: CompiledConfig): void {
    this.stop();
    for (const task of config.tasks) {
      if (task.kind === 'cron') {
        this.arm(task);
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

  private arm(task: CompiledTask): void {
    const trigger = task.config.trigger;
    if (trigger.kind !== 'cron') {
      return;
    }
    const { schedule } = trigger;
    const options: CronOptions = {
      name: task.name,
      catch: (err: unknown) => {
        this.log.error('cron.tick_failed', {
          task: task.name,
          error: err instanceof Error ? err.message : String(err),
        });
      },
      ...(trigger.tz === undefined ? {} : { timezone: trigger.tz }),
    };
    const job = new Cron(schedule, options, () => {
      const at = floorToBoundary(this.clock.now(), schedule);
      const result = this.bus.publish(makeTickEvent(task.name, at));
      this.log.debug(result.status === 'inserted' ? 'cron.tick' : 'cron.tick_duplicate', {
        task: task.name,
        scheduled_at: at.toISOString(),
      });
    });
    this.jobs.set(task.name, { job, schedule });
    this.log.info('cron.armed', {
      task: task.name,
      schedule,
      next_run: job.nextRun()?.toISOString() ?? null,
    });
  }
}
