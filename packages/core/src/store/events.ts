import type { Database, Statement } from 'better-sqlite3';

import { compileTypePattern, isTypePattern } from '../expr/glob.js';
import type { EventRecord, JsonValue } from './types.js';

interface EventRow {
  seq: number;
  id: string;
  type: string;
  source: string;
  ts: string;
  correlation_id: string;
  parent_id: string | null;
  dedup_key: string | null;
  depth: number;
  payload: string;
  root_id: string | null;
}

function rowToEvent(row: unknown): EventRecord {
  const { root_id: _root, ...r } = row as EventRow;
  return { ...r, payload: JSON.parse(r.payload) as JsonValue };
}

export type InsertEventResult = { inserted: true; seq: number } | { inserted: false };

export interface EventFilter {
  /** Events with `seq > after`; without it, the newest `limit` events. */
  after?: number | undefined;
  /** An exact type or a trigger-style pattern (`*` = one segment). */
  type?: string | undefined;
  /** Capped at 1000; default 50. */
  limit?: number | undefined;
}

export class EventStore {
  private readonly insertStmt: Statement;
  private readonly byIdStmt: Statement;
  private readonly afterStmt: Statement;
  private readonly purgeStmt: Statement;
  private readonly rootStmt: Statement;
  private readonly chainRunsStmt: Statement;
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    // `type_matches(pattern, type)` gives SQL the trigger's pattern semantics.
    db.function('type_matches', { deterministic: true }, (pattern, type) =>
      compileTypePattern(String(pattern))(String(type)) ? 1 : 0,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO events (id, type, source, ts, correlation_id, parent_id, dedup_key, depth, payload, root_id)
       VALUES (@id, @type, @source, @ts, @correlation_id, @parent_id, @dedup_key, @depth, @payload, @root_id)
       ON CONFLICT(dedup_key) DO NOTHING`,
    );
    this.byIdStmt = db.prepare('SELECT * FROM events WHERE id = ?');
    this.afterStmt = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?');
    this.rootStmt = db.prepare('SELECT COALESCE(root_id, id) AS root FROM events WHERE id = ?');
    this.chainRunsStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM runs r JOIN events e ON e.id = r.event_id
       WHERE e.root_id = @root OR (e.id = @root AND e.root_id IS NULL)`,
    );
    // Only events the dispatcher has passed, and none a run or an unresumed wait still points at.
    this.purgeStmt = db.prepare(
      `DELETE FROM events WHERE seq IN (
         SELECT e.seq FROM events e
         WHERE e.seq <= @max_seq AND e.ts < @before
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.event_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM waits w WHERE w.event_id = e.id)
         ORDER BY e.seq LIMIT @limit)`,
    );
  }

  /**
   * Appends an event. A `dedup_key` collision is not an error: the event is dropped.
   * `rootId` is the root of its causal chain (`rootOf(parent)`); a root passes none.
   */
  insert(event: Omit<EventRecord, 'seq'>, rootId?: string): InsertEventResult {
    const info = this.insertStmt.run({
      ...event,
      payload: JSON.stringify(event.payload),
      root_id: rootId ?? event.id,
    });
    if (info.changes === 0) {
      return { inserted: false };
    }
    return { inserted: true, seq: Number(info.lastInsertRowid) };
  }

  getById(id: string): EventRecord | undefined {
    const row: unknown = this.byIdStmt.get(id);
    return row === undefined ? undefined : rowToEvent(row);
  }

  /** The root event of `id`'s causal chain: itself for a root or a row older than `root_id`. */
  rootOf(id: string): string | undefined {
    const row = this.rootStmt.get(id) as { root: string } | undefined;
    return row?.root;
  }

  /** Runs started by events of the chain rooted at `rootId`, a root older than `root_id` included. */
  countChainRuns(rootId: string): number {
    return (this.chainRunsStmt.get({ root: rootId }) as { n: number }).n;
  }

  listAfter(seq: number, limit: number): EventRecord[] {
    return this.afterStmt.all(seq, limit).map(rowToEvent);
  }

  /** In `seq` order, for `oa events tail`: the newest `limit`, or those after a `seq`. */
  list(filter: EventFilter = {}): EventRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.after !== undefined) {
      where.push('seq > ?');
      params.push(filter.after);
    }
    if (filter.type !== undefined) {
      where.push(isTypePattern(filter.type) ? 'type_matches(?, type)' : 'type = ?');
      params.push(filter.type);
    }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')} `;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000);
    if (filter.after !== undefined) {
      return this.db
        .prepare(`SELECT * FROM events ${clause}ORDER BY seq LIMIT ?`)
        .all(...params, limit)
        .map(rowToEvent);
    }
    return this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM events ${clause}ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
      )
      .all(...params, limit)
      .map(rowToEvent);
  }

  /**
   * Retention: deletes up to `limit` events with `ts < beforeIso` that are already
   * dispatched (`seq <= maxSeq`) and referenced by no run or wait. Returns how many went.
   */
  deleteUnreferencedBefore(beforeIso: string, maxSeq: number, limit: number): number {
    return this.purgeStmt.run({ before: beforeIso, max_seq: maxSeq, limit }).changes;
  }
}
