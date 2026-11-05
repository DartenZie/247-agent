import type { RunRecord } from '../store/types.js';
import type { NoMatchReason } from './matcher.js';

/**
 * Why a task's trigger matched an event but started no run: the event was past
 * `limits.max_event_depth`, the task is paused, a run of the cron task was active
 * (`overlap: skip`), or the event's chain had reached `limits.max_runs_per_chain`.
 * `unknown` when none of these holds any more (a reload changed the task, or retention
 * removed the run).
 */
export type SkipReason = 'depth' | 'paused' | 'overlap' | 'chain_runs' | 'unknown';

/** One task of the active configuration and what an event did to it. */
export interface TaskMatch {
  task: string;
  /**
   * `started`: the event started `run_id`. `pending`: the trigger matches and the event
   * is not dispatched yet. `skipped`: the trigger matches but no run started (`reason`).
   * `no_match`: the trigger does not match (`reason`).
   */
  outcome: 'started' | 'pending' | 'skipped' | 'no_match';
  reason: NoMatchReason | SkipReason | null;
  /** Human-readable context for `reason`: what the trigger wants, the filter, the limit. */
  detail: string | null;
  run_id: string | null;
}

/** `GET /v1/events/{id}/tasks`, and `tasks` in a `POST /v1/events` answer. */
export interface EventExplanation {
  event_id: string;
  /** False while the event is past the dispatch cursor. */
  dispatched: boolean;
  /** Every run the event started, also of tasks no longer configured. */
  runs: RunRecord[];
  /** The tasks of the active configuration, in config order. */
  tasks: TaskMatch[];
  /**
   * Waiting runs whose wait the event matches. A wait ends when the event is dispatched,
   * so this is empty once `dispatched` is true.
   */
  waiting_runs: string[];
}
