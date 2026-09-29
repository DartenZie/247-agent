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
}

function rowToEvent(row: unknown): EventRecord {
  const r = row as EventRow;
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
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    // `type_matches(pattern, type)` gives SQL the trigger's pattern semantics.
    db.function('type_matches', { deterministic: true }, (pattern, type) =>
      compileTypePattern(String(pattern))(String(type)) ? 1 : 0,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO events (id, type, source, ts, correlation_id, parent_id, dedup_key, depth, payload)
       VALUES (@id, @type, @source, @ts, @correlation_id, @parent_id, @dedup_key, @depth, @payload)
       ON CONFLICT(dedup_key) DO NOTHING`,
    );
    this.byIdStmt = db.prepare('SELECT * FROM events WHERE id = ?');
    this.afterStmt = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?');
  }

  /** Appends an event. A `dedup_key` collision is not an error: the event is dropped. */
  insert(event: Omit<EventRecord, 'seq'>): InsertEventResult {
    const info = this.insertStmt.run({ ...event, payload: JSON.stringify(event.payload) });
    if (info.changes === 0) {
      return { inserted: false };
    }
    return { inserted: true, seq: Number(info.lastInsertRowid) };
  }

  getById(id: string): EventRecord | undefined {
    const row: unknown = this.byIdStmt.get(id);
    return row === undefined ? undefined : rowToEvent(row);
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
}
