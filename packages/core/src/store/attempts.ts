import type { Database, Statement } from 'better-sqlite3';

/**
 * `running` while it runs, `waiting` while the run is parked in a `wait` (the attempt goes on
 * when the run resumes), `interrupted` when a stop or a crash cut it short; the rest end it.
 */
export type AttemptStatus =
  'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

/** One attempt of a run (docs/internal/store.md, `run_attempts`). */
export interface AttemptRecord {
  run_id: string;
  /** 1 for the first; the run's `attempt` is the latest. */
  attempt: number;
  status: AttemptStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  /** The last few KiB the action's child processes printed, secrets redacted; null when silent. */
  stdout: string | null;
  stderr: string | null;
}

export interface AttemptEnd {
  status: AttemptStatus;
  /** `null` while the attempt is only parked (`waiting`). */
  finished_at: string | null;
  error: string | null;
}

/** Per-attempt history of runs: one row per `(run_id, attempt)`. */
export class RunAttemptStore {
  private readonly replaceStmt: Statement;
  private readonly resumeStmt: Statement;
  private readonly outputStmt: Statement;
  private readonly endStmt: Statement;
  private readonly closeOpenStmt: Statement;
  private readonly getStmt: Statement;
  private readonly listStmt: Statement;
  private readonly deleteForRunStmt: Statement;

  constructor(db: Database) {
    this.replaceStmt = db.prepare(
      `INSERT OR REPLACE INTO run_attempts (run_id, attempt, status, started_at)
       VALUES (?, ?, 'running', ?)`,
    );
    this.resumeStmt = db.prepare(
      `UPDATE run_attempts SET status = 'running', finished_at = NULL
       WHERE run_id = ? AND attempt = ?`,
    );
    this.outputStmt = db.prepare(
      'UPDATE run_attempts SET stdout = ?, stderr = ? WHERE run_id = ? AND attempt = ?',
    );
    this.endStmt = db.prepare(
      `UPDATE run_attempts SET status = @status, finished_at = @finished_at, error = @error
       WHERE run_id = @run_id AND attempt = @attempt`,
    );
    this.closeOpenStmt = db.prepare(
      `UPDATE run_attempts SET status = @status, finished_at = @finished_at, error = @error
       WHERE run_id = @run_id AND status IN ('running', 'waiting')`,
    );
    this.getStmt = db.prepare('SELECT * FROM run_attempts WHERE run_id = ? AND attempt = ?');
    this.listStmt = db.prepare('SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt');
    this.deleteForRunStmt = db.prepare('DELETE FROM run_attempts WHERE run_id = ?');
  }

  /**
   * Records that the attempt starts. `resume`: the attempt goes on after a wait and keeps its
   * start and output; otherwise a row left by an attempt that a stop gave back is replaced.
   */
  start(runId: string, attempt: number, startedAt: string, opts: { resume?: boolean } = {}): void {
    if (opts.resume === true && this.resumeStmt.run(runId, attempt).changes === 1) {
      return;
    }
    this.replaceStmt.run(runId, attempt, startedAt);
  }

  setOutput(
    runId: string,
    attempt: number,
    out: { stdout: string | null; stderr: string | null },
  ): void {
    this.outputStmt.run(out.stdout, out.stderr, runId, attempt);
  }

  end(runId: string, attempt: number, end: AttemptEnd): void {
    this.endStmt.run({ run_id: runId, attempt, ...end });
  }

  /** Ends whatever attempt of the run is still `running` or `waiting`. */
  closeOpen(runId: string, end: AttemptEnd): void {
    this.closeOpenStmt.run({ run_id: runId, ...end });
  }

  get(runId: string, attempt: number): AttemptRecord | undefined {
    return this.getStmt.get(runId, attempt) as AttemptRecord | undefined;
  }

  listByRun(runId: string): AttemptRecord[] {
    return this.listStmt.all(runId) as AttemptRecord[];
  }

  /** Retention: the attempts of runs about to be deleted. Returns how many went. */
  deleteForRuns(runIds: readonly string[]): number {
    let n = 0;
    for (const id of runIds) {
      n += this.deleteForRunStmt.run(id).changes;
    }
    return n;
  }
}
