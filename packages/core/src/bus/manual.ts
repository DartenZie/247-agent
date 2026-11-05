import { applyParams, type ParamIssue } from '../config/params.js';
import type { JsonValue, RunRecord } from '../store/types.js';
import type { Store } from '../store/store.js';
import type { EventBus } from './bus.js';
import { MANUAL_RUN, type CompiledConfig } from './matcher.js';

export interface ManualInput {
  /** Type of the event the action should see as its trigger; defaults to `manual.input`. */
  type?: string | undefined;
  payload?: JsonValue | undefined;
  correlation_id?: string | undefined;
}

export class UnknownTaskError extends Error {
  constructor(readonly task: string) {
    super(`unknown task "${task}"`);
    this.name = 'UnknownTaskError';
  }
}

/** The input of a manual run does not fit the params the task declares. */
export class InvalidParamsError extends Error {
  constructor(
    readonly task: string,
    readonly issues: ParamIssue[],
  ) {
    super(`invalid params for task "${task}"`);
    this.name = 'InvalidParamsError';
  }
}

export class TaskPausedError extends Error {
  constructor(readonly task: string) {
    super(`task "${task}" is paused: resume it with oa tasks resume ${task}`);
    this.name = 'TaskPausedError';
  }
}

/**
 * `oa run <task>`: publishes a `manual.run` event for the task and dispatches it
 * synchronously. Works for any task regardless of its trigger kind; filters and cron
 * overlap-skip do not apply; a paused task is refused (`TaskPausedError`), and so is input
 * that does not fit a manual trigger's `params` (`InvalidParamsError`), whose defaults
 * are filled in otherwise. Never
 * deduplicated: every call is a new run.
 *
 * Executor rule: for a `manual.run` trigger event the action context's `event` is
 * `payload.event` when present, otherwise the `manual.run` event itself.
 */
export function runTaskManually(
  bus: EventBus,
  store: Store,
  config: CompiledConfig,
  taskName: string,
  input?: ManualInput,
): { event_id: string; run: RunRecord } {
  const task = config.byName.get(taskName);
  if (task === undefined) {
    throw new UnknownTaskError(taskName);
  }
  if (store.pauses.pausedAt(taskName) !== undefined) {
    throw new TaskPausedError(taskName);
  }
  let event: { type: string; payload: JsonValue } | null =
    input === undefined
      ? null
      : { type: input.type ?? 'manual.input', payload: input.payload ?? null };
  const trigger = task.config.trigger;
  if (trigger.kind === 'manual' && trigger.params !== undefined) {
    const checked = applyParams(trigger.params, input?.payload);
    if (!checked.ok) {
      throw new InvalidParamsError(taskName, checked.issues);
    }
    event = { type: input?.type ?? 'manual.input', payload: checked.payload };
  }
  const published = bus.publish({
    type: MANUAL_RUN,
    source: 'manual',
    correlation_id: input?.correlation_id,
    payload: {
      task: taskName,
      event,
    },
  });
  if (published.status !== 'inserted') {
    throw new Error('manual.run events are never deduplicated'); // unreachable: no dedup_key
  }
  bus.dispatcher.drain();
  const run = store.runs.getByTaskAndEvent(taskName, published.event.id);
  if (run === undefined) {
    throw new Error(`run for task "${taskName}" was not queued`); // unreachable: every task matches its manual.run
  }
  return { event_id: published.event.id, run };
}
