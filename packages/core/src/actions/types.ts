import type { TaskConfig } from '../config/schema.js';
import type { Logger } from '../log.js';
import type { EventRecord, JsonValue, RunRecord } from '../store/types.js';

/**
 * What every action runner receives. `event` is the triggering event as the action should
 * see it: for a `manual.run` trigger with `payload.event`, that inner event (with the
 * `manual.run` event's ids and correlation), otherwise the trigger event itself.
 *
 * `state` and `secrets` (ARCHITECTURE §5) arrive with the actions that need them.
 */
export interface ActionContext {
  readonly run: RunRecord;
  readonly event: EventRecord;
  readonly task: TaskConfig;
  /** Aborted on task timeout or daemon shutdown; runners must stop what they started. */
  readonly signal: AbortSignal;
  /** Already carries `run_id`, `task` and `correlation_id`. */
  readonly log: Logger;
}

/**
 * One runner per action kind, in its own file. The runner narrows `action` with its own
 * zod schema, does the work and returns the JSON result the core stores and routes.
 * A thrown error (or rejection) fails the run with the error's message.
 */
export type ActionRunner = (action: TaskConfig['action'], ctx: ActionContext) => Promise<JsonValue>;

export type ActionKind = TaskConfig['action']['kind'];

export type ActionRunners = Partial<Record<ActionKind, ActionRunner>>;
