import type { Database, Statement } from 'better-sqlite3';

/** How a row's `usd` was determined (ARCHITECTURE §9): no call goes unpriced silently. */
export type PricedBy = 'table' | 'provider' | 'unpriced';

export interface LedgerEntry {
  id: number;
  run_id: string;
  task: string;
  provider: string;
  model: string;
  in_tok: number;
  out_tok: number;
  cache_read: number;
  cache_write: number;
  usd: number;
  priced_by: PricedBy;
  ts: string;
}

export type NewLedgerEntry = Omit<LedgerEntry, 'id'>;

export type CostGroup = 'task' | 'model' | 'provider' | 'day';

/** One line of `oa cost --by <group>`. */
export interface CostRow {
  key: string;
  calls: number;
  in_tok: number;
  out_tok: number;
  cache_read: number;
  cache_write: number;
  usd: number;
}

const GROUP_EXPR: Record<CostGroup, string> = {
  task: 'task',
  model: 'model',
  provider: 'provider',
  day: 'substr(ts, 1, 10)',
};

/**
 * The cost ledger (ARCHITECTURE §9): one row per model call. Budgets are derived from it
 * (`sumSince` for the daily cap, `sumForRun` for a run's `max_usd`), so a restart loses nothing.
 */
export class LedgerStore {
  private readonly insertStmt: Statement;
  private readonly sumSinceStmt: Statement;
  private readonly sumForRunStmt: Statement;
  private readonly listByRunStmt: Statement;
  private readonly summaryStmts: Record<CostGroup, Statement>;

  constructor(db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO ledger (run_id, task, provider, model, in_tok, out_tok, cache_read, cache_write, usd, priced_by, ts)
       VALUES (@run_id, @task, @provider, @model, @in_tok, @out_tok, @cache_read, @cache_write, @usd, @priced_by, @ts)`,
    );
    this.sumSinceStmt = db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM ledger WHERE ts >= ?');
    this.sumForRunStmt = db.prepare(
      'SELECT COALESCE(SUM(usd), 0) AS usd FROM ledger WHERE run_id = ?',
    );
    this.listByRunStmt = db.prepare('SELECT * FROM ledger WHERE run_id = ? ORDER BY id');
    const summary = (group: CostGroup): Statement =>
      db.prepare(
        `SELECT ${GROUP_EXPR[group]} AS key, COUNT(*) AS calls, SUM(in_tok) AS in_tok,
                SUM(out_tok) AS out_tok, SUM(cache_read) AS cache_read,
                SUM(cache_write) AS cache_write, SUM(usd) AS usd
         FROM ledger WHERE ts >= ? GROUP BY 1 ORDER BY usd DESC, key`,
      );
    this.summaryStmts = {
      task: summary('task'),
      model: summary('model'),
      provider: summary('provider'),
      day: summary('day'),
    };
  }

  /** Returns the new row id. */
  insert(entry: NewLedgerEntry): number {
    return Number(this.insertStmt.run(entry).lastInsertRowid);
  }

  /** Total USD of rows with `ts >= since` (an ISO timestamp). */
  sumSince(since: string): number {
    return (this.sumSinceStmt.get(since) as { usd: number }).usd;
  }

  sumForRun(runId: string): number {
    return (this.sumForRunStmt.get(runId) as { usd: number }).usd;
  }

  listByRun(runId: string): LedgerEntry[] {
    return this.listByRunStmt.all(runId) as LedgerEntry[];
  }

  /** Totals grouped by `by` for rows with `ts >= since`, most expensive first. */
  summary(opts: { since: string; by: CostGroup }): CostRow[] {
    return this.summaryStmts[opts.by].all(opts.since) as CostRow[];
  }
}
