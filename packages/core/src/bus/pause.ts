import type { Clock } from '../clock.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/store.js';
import { RUN_STATUSES, type RunRecord, type RunStatus } from '../store/types.js';
import { UnknownTaskError } from './manual.js';
import type { CompiledConfig, CompiledTask } from './matcher.js';

/** `GET /v1/tasks`: a configured task, its trigger, whether it is paused and how it ran. */
export interface TaskEntry {
  name: string;
  trigger: CompiledTask['kind'];
  /** When `oa tasks pause` paused it; `null` when it runs normally. */
  paused_at: string | null;
  /** Cron: the schedule; else `null`. */
  schedule: string | null;
  /** Cron: when the schedule fires next; else `null`. */
  next_fire: string | null;
  /** Event: the types or patterns the trigger names; else `null`. */
  types: string[] | null;
  /** Event: the trigger's filter; else `null`. */
  filter: string | null;
  /** The newest run of the task, whatever its status; `null` when it has none. */
  last_run: Pick<RunRecord, 'id' | 'status' | 'created_at' | 'finished_at'> | null;
  /** The task's runs the store holds (retention removes old ones), per status and in all. */
  runs: Record<RunStatus | 'total', number>;
}

/** What a `TaskEntry` is built from besides the task: the store and the cron scheduler. */
export interface TaskInfo {
  store: Store;
  /** When the task's cron job fires next; `null` for a task with no armed job. */
  nextFire(task: string): Date | null;
}

function counts(given: Partial<Record<RunStatus, number>> | undefined): TaskEntry['runs'] {
  const out = { total: 0 } as TaskEntry['runs'];
  for (const status of RUN_STATUSES) {
    out[status] = given?.[status] ?? 0;
    out.total += out[status];
  }
  return out;
}

function entry(
  info: TaskInfo,
  task: CompiledTask,
  allCounts = info.store.runs.countsByTask(),
): TaskEntry {
  const { trigger } = task.config;
  const [last] = info.store.runs.list({ task: task.name, limit: 1 });
  return {
    name: task.name,
    trigger: task.kind,
    paused_at: info.store.pauses.pausedAt(task.name) ?? null,
    schedule: trigger.kind === 'cron' ? trigger.schedule : null,
    next_fire: trigger.kind === 'cron' ? (info.nextFire(task.name)?.toISOString() ?? null) : null,
    types:
      trigger.kind === 'event'
        ? trigger.type !== undefined
          ? [trigger.type]
          : [...(trigger.type_any ?? [])]
        : null,
    filter: trigger.kind === 'event' ? (trigger.filter ?? null) : null,
    last_run:
      last === undefined
        ? null
        : {
            id: last.id,
            status: last.status,
            created_at: last.created_at,
            finished_at: last.finished_at,
          },
    runs: counts(allCounts.get(task.name)),
  };
}

/** The configured tasks in config order. */
export function listTasks(info: TaskInfo, config: CompiledConfig): TaskEntry[] {
  const allCounts = info.store.runs.countsByTask();
  return config.tasks.map((t) => entry(info, t, allCounts));
}

/**
 * `oa tasks pause <task>`: the dispatcher starts no new run of the task until it is resumed,
 * whatever triggers it, and `oa run` refuses it. Runs already queued, running or waiting carry
 * on. Pausing a paused task keeps its `paused_at`.
 */
export function pauseTask(
  info: TaskInfo,
  config: CompiledConfig,
  clock: Clock,
  log: Logger,
  name: string,
): TaskEntry {
  const task = config.byName.get(name);
  if (task === undefined) {
    throw new UnknownTaskError(name);
  }
  if (info.store.pauses.pause(name, clock.now().toISOString())) {
    log.info('task.paused', { task: name });
  }
  return entry(info, task);
}

/** `oa tasks resume <task>`: events from now on start runs again; skipped ones stay skipped. */
export function resumeTask(
  info: TaskInfo,
  config: CompiledConfig,
  log: Logger,
  name: string,
): TaskEntry {
  const task = config.byName.get(name);
  if (task === undefined) {
    throw new UnknownTaskError(name);
  }
  if (info.store.pauses.resume(name)) {
    log.info('task.resumed', { task: name });
  }
  return entry(info, task);
}
