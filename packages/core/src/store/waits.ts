import type { Database, Statement } from 'better-sqlite3';

import type { JsonValue } from './types.js';

export type WaitOutcome = 'matched' | 'timeout';

/** A suspended run (ARCHITECTURE §5.6): what it waits for and how to pick up afterwards. */
export interface WaitRecord {
  run_id: string;
  task: string;
  /** Event type pattern (`*` = one segment). */
  type: string;
  /** Rendered JMESPath over the incoming event, or null. */
  filter: string | null;
  expires_at: string | null;
  on_timeout: 'fail' | 'succeed';
  /** Runner-private: where to continue (sequence step index and earlier results). */
  resume: JsonValue;
  created_at: string;
  /** Set once the wait is over; the run is then resumed by the executor. */
  outcome: WaitOutcome | null;
  /** The matching event when `outcome` is `matched`. */
  event_id: string | null;
}

interface WaitRow extends Omit<WaitRecord, 'resume'> {
  resume: string;
}

function rowToWait(row: unknown): WaitRecord {
  const r = row as WaitRow;
  return { ...r, resume: JSON.parse(r.resume) as JsonValue };
}

export class WaitStore {
  private readonly insertStmt: Statement;
  private readonly getStmt: Statement;
  private readonly pendingStmt: Statement;
  private readonly resolvedStmt: Statement;
  private readonly expiredStmt: Statement;
  private readonly resolveStmt: Statement;
  private readonly deleteStmt: Statement;

  constructor(db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO waits (run_id, task, type, filter, expires_at, on_timeout, resume, created_at)
       VALUES (@run_id, @task, @type, @filter, @expires_at, @on_timeout, @resume, @created_at)`,
    );
    this.getStmt = db.prepare('SELECT * FROM waits WHERE run_id = ?');
    this.pendingStmt = db.prepare('SELECT * FROM waits WHERE outcome IS NULL ORDER BY created_at');
    this.resolvedStmt = db.prepare(
      'SELECT * FROM waits WHERE outcome IS NOT NULL ORDER BY created_at',
    );
    this.expiredStmt = db.prepare(
      'SELECT * FROM waits WHERE outcome IS NULL AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at',
    );
    this.resolveStmt = db.prepare(
      'UPDATE waits SET outcome = ?, event_id = ? WHERE run_id = ? AND outcome IS NULL',
    );
    this.deleteStmt = db.prepare('DELETE FROM waits WHERE run_id = ?');
  }

  /** One wait per run: a second insert for the same run replaces the first. */
  insert(wait: Omit<WaitRecord, 'outcome' | 'event_id'>): void {
    this.deleteStmt.run(wait.run_id);
    this.insertStmt.run({ ...wait, resume: JSON.stringify(wait.resume) });
  }

  get(runId: string): WaitRecord | undefined {
    const row: unknown = this.getStmt.get(runId);
    return row === undefined ? undefined : rowToWait(row);
  }

  /** Waits still armed. */
  listPending(): WaitRecord[] {
    return this.pendingStmt.all().map(rowToWait);
  }

  /** Waits that are over but whose run has not been resumed yet. */
  listResolved(): WaitRecord[] {
    return this.resolvedStmt.all().map(rowToWait);
  }

  listExpired(nowIso: string): WaitRecord[] {
    return this.expiredStmt.all(nowIso).map(rowToWait);
  }

  /** Marks the wait over. Returns false when it was already resolved or removed. */
  resolve(runId: string, outcome: WaitOutcome, eventId: string | null): boolean {
    return this.resolveStmt.run(outcome, eventId, runId).changes === 1;
  }

  delete(runId: string): boolean {
    return this.deleteStmt.run(runId).changes === 1;
  }
}
