import type { Database, Statement } from 'better-sqlite3';

/**
 * One Message Batches request an `llm` action with `batch: true` submitted and whose
 * result has not been ledgered yet (ARCHITECTURE §5.2). The row outlives the run's wait:
 * the provider bills a batch however the run ended, so the poller settles it regardless.
 */
export interface BatchRecord {
  batch_id: string;
  run_id: string;
  task: string;
  /** The run attempt that submitted it. */
  attempt: number;
  provider: string;
  model: string;
  /** Whether the request had an `output_schema` (the result is then parsed as JSON). */
  structured: boolean;
  /** The worst-case cost at the batch price, reserved against the daily cap until settled. */
  worst_usd: number;
  submitted_at: string;
}

interface BatchRow extends Omit<BatchRecord, 'structured'> {
  structured: number;
}

function rowToBatch(row: unknown): BatchRecord {
  const r = row as BatchRow;
  return { ...r, structured: r.structured === 1 };
}

export class BatchStore {
  private readonly insertStmt: Statement;
  private readonly listStmt: Statement;
  private readonly forRunStmt: Statement;
  private readonly countStmt: Statement;
  private readonly reservedStmt: Statement;
  private readonly deleteStmt: Statement;

  constructor(db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO llm_batches (batch_id, run_id, task, attempt, provider, model, structured, worst_usd, submitted_at)
       VALUES (@batch_id, @run_id, @task, @attempt, @provider, @model, @structured, @worst_usd, @submitted_at)`,
    );
    this.listStmt = db.prepare('SELECT * FROM llm_batches ORDER BY submitted_at');
    this.forRunStmt = db.prepare(
      'SELECT * FROM llm_batches WHERE run_id = ? ORDER BY submitted_at DESC LIMIT 1',
    );
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM llm_batches');
    this.reservedStmt = db.prepare('SELECT COALESCE(SUM(worst_usd), 0) AS usd FROM llm_batches');
    this.deleteStmt = db.prepare('DELETE FROM llm_batches WHERE batch_id = ?');
  }

  insert(batch: BatchRecord): void {
    this.insertStmt.run({ ...batch, structured: batch.structured ? 1 : 0 });
  }

  /** Every batch still in flight, oldest first. */
  list(): BatchRecord[] {
    return this.listStmt.all().map(rowToBatch);
  }

  /** The newest batch of a run still in flight, if any. */
  forRun(runId: string): BatchRecord | undefined {
    const row: unknown = this.forRunStmt.get(runId);
    return row === undefined ? undefined : rowToBatch(row);
  }

  /** How many batches are in flight (the `oa_llm_batches_pending` gauge). */
  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /** The worst-case USD of every batch in flight: spend not in the ledger yet. */
  reservedUsd(): number {
    return (this.reservedStmt.get() as { usd: number }).usd;
  }

  delete(batchId: string): boolean {
    return this.deleteStmt.run(batchId).changes === 1;
  }
}
