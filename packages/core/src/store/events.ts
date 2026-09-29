import type { Database, Statement } from 'better-sqlite3';

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

export class EventStore {
  private readonly insertStmt: Statement;
  private readonly byIdStmt: Statement;
  private readonly afterStmt: Statement;
  private readonly purgeStmt: Statement;

  constructor(db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO events (id, type, source, ts, correlation_id, parent_id, dedup_key, depth, payload)
       VALUES (@id, @type, @source, @ts, @correlation_id, @parent_id, @dedup_key, @depth, @payload)
       ON CONFLICT(dedup_key) DO NOTHING`,
    );
    this.byIdStmt = db.prepare('SELECT * FROM events WHERE id = ?');
    this.afterStmt = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?');
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

  /**
   * Retention: deletes up to `limit` events with `ts < beforeIso` that are already
   * dispatched (`seq <= maxSeq`) and referenced by no run or wait. Returns how many went.
   */
  deleteUnreferencedBefore(beforeIso: string, maxSeq: number, limit: number): number {
    return this.purgeStmt.run({ before: beforeIso, max_seq: maxSeq, limit }).changes;
  }
}
