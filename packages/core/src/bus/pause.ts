import type { Clock } from '../clock.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/store.js';
import { UnknownTaskError } from './manual.js';
import type { CompiledConfig, CompiledTask } from './matcher.js';

/** `GET /v1/tasks`: a configured task and whether it is paused. */
export interface TaskEntry {
  name: string;
  trigger: CompiledTask['kind'];
  /** When `oa tasks pause` paused it; `null` when it runs normally. */
  paused_at: string | null;
}

function entry(store: Store, task: CompiledTask): TaskEntry {
  return {
    name: task.name,
    trigger: task.kind,
    paused_at: store.pauses.pausedAt(task.name) ?? null,
  };
}

/** The configured tasks in config order. */
export function listTasks(store: Store, config: CompiledConfig): TaskEntry[] {
  return config.tasks.map((t) => entry(store, t));
}

/**
 * `oa tasks pause <task>`: the dispatcher starts no new run of the task until it is resumed,
 * whatever triggers it, and `oa run` refuses it. Runs already queued, running or waiting carry
 * on. Pausing a paused task keeps its `paused_at`.
 */
export function pauseTask(
  store: Store,
  config: CompiledConfig,
  clock: Clock,
  log: Logger,
  name: string,
): TaskEntry {
  const task = config.byName.get(name);
  if (task === undefined) {
    throw new UnknownTaskError(name);
  }
  if (store.pauses.pause(name, clock.now().toISOString())) {
    log.info('task.paused', { task: name });
  }
  return entry(store, task);
}

/** `oa tasks resume <task>`: events from now on start runs again; skipped ones stay skipped. */
export function resumeTask(
  store: Store,
  config: CompiledConfig,
  log: Logger,
  name: string,
): TaskEntry {
  const task = config.byName.get(name);
  if (task === undefined) {
    throw new UnknownTaskError(name);
  }
  if (store.pauses.resume(name)) {
    log.info('task.resumed', { task: name });
  }
  return entry(store, task);
}
