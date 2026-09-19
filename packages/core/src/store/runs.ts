import type { Database, Statement } from 'better-sqlite3';

import { ACTIVE_STATUSES, type JsonValue, type RunRecord, type RunStatus } from './types.js';

interface RunRow extends Omit<RunRecord, 'result'> {
  result: string | null;
}

function rowToRun(row: unknown): RunRecord {
  const r = row as RunRow;
  return { ...r, result: r.result === null ? null : (JSON.parse(r.result) as JsonValue) };
}

export interface NewRun {
  id: string;
  task: string;
  event_id: string;
  correlation_id: string;
  created_at: string;
}

export interface RunFilter {
  status?: RunStatus | undefined;
  task?: string | undefined;
  /** Capped at 1000; default 50. */
  limit?: number | undefined;
}

export interface RunPatch {
  started_at?: string;
  finished_at?: string;
  result?: JsonValue;
  error?: string;
  attempt?: number;
}

export class RunStore {
  private readonly db: Database;
  private readonly insertStmt: Statement;
  private readonly hasActiveStmt: Statement;
  private readonly byStatusStmt: Statement;
  private readonly byIdStmt: Statement;
  private readonly byTaskEventStmt: Statement;
  private readonly setStatusStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO runs (id, task, event_id, correlation_id, status, created_at)
       VALUES (@id, @task, @event_id, @correlation_id, 'queued', @created_at)`,
    );
    const active = ACTIVE_STATUSES.map((s) => `'${s}'`).join(',');
    this.hasActiveStmt = db.prepare(
      `SELECT 1 FROM runs WHERE task = ? AND status IN (${active}) LIMIT 1`,
    );
    this.byStatusStmt = db.prepare(
      'SELECT * FROM runs WHERE status = ? ORDER BY created_at, id LIMIT ?',
    );
    this.byIdStmt = db.prepare('SELECT * FROM runs WHERE id = ?');
    this.byTaskEventStmt = db.prepare('SELECT * FROM runs WHERE task = ? AND event_id = ?');
    this.setStatusStmt = db.prepare(
      `UPDATE runs SET status = @status,
         started_at  = COALESCE(@started_at, started_at),
         finished_at = COALESCE(@finished_at, finished_at),
         result      = COALESCE(@result, result),
         error       = COALESCE(@error, error),
         attempt     = COALESCE(@attempt, attempt)
       WHERE id = @id`,
    );
  }

  /** Inserts a `queued` run. Returns false when `(task, event_id)` already has one. */
  insertQueued(run: NewRun): boolean {
    return this.insertStmt.run(run).changes === 1;
  }

  /** True when the task has a run in `queued`, `running` or `waiting`. */
  hasActive(task: string): boolean {
    return this.hasActiveStmt.get(task) !== undefined;
  }

  listByStatus(status: RunStatus, limit = 1000): RunRecord[] {
    return this.byStatusStmt.all(status, limit).map(rowToRun);
  }

  /** Newest first, for the API and CLI. */
  list(filter: RunFilter = {}): RunRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status !== undefined) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.task !== undefined) {
      where.push('task = ?');
      params.push(filter.task);
    }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')} `;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000);
    return this.db
      .prepare(`SELECT * FROM runs ${clause}ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit)
      .map(rowToRun);
  }

  getById(id: string): RunRecord | undefined {
    const row: unknown = this.byIdStmt.get(id);
    return row === undefined ? undefined : rowToRun(row);
  }

  getByTaskAndEvent(task: string, eventId: string): RunRecord | undefined {
    const row: unknown = this.byTaskEventStmt.get(task, eventId);
    return row === undefined ? undefined : rowToRun(row);
  }

  /** Executor seam: transitions status and fills in timestamps/result as they become known. */
  setStatus(id: string, status: RunStatus, patch: RunPatch = {}): void {
    this.setStatusStmt.run({
      id,
      status,
      started_at: patch.started_at ?? null,
      finished_at: patch.finished_at ?? null,
      result: patch.result === undefined ? null : JSON.stringify(patch.result),
      error: patch.error ?? null,
      attempt: patch.attempt ?? null,
    });
  }
}
