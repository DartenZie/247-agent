export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

/** Statuses that count as "the task is busy" for `overlap: skip`. */
export const ACTIVE_STATUSES = [
  'queued',
  'running',
  'waiting',
] as const satisfies readonly RunStatus[];

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A persisted event. `seq` is the dispatch order; `id` is the public handle. */
export interface EventRecord {
  seq: number;
  id: string;
  type: string;
  /** Connector name, `scheduler`, `manual`, or `task:<name>` for run-produced events. */
  source: string;
  ts: string;
  correlation_id: string;
  parent_id: string | null;
  dedup_key: string | null;
  /** Hops from the root of the causal chain; the dispatcher stops runaway loops by depth. */
  depth: number;
  payload: JsonValue;
}

/** What a publisher supplies. The core assigns the rest. */
export interface NewEvent {
  type: string;
  source: string;
  payload?: JsonValue | undefined;
  dedup_key?: string | undefined;
  parent_id?: string | undefined;
  correlation_id?: string | undefined;
}

export interface RunRecord {
  id: string;
  task: string;
  event_id: string;
  correlation_id: string;
  status: RunStatus;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: JsonValue | null;
  error: string | null;
}
