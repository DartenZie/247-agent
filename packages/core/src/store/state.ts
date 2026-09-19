import type { Database, Statement } from 'better-sqlite3';

import type { JsonValue } from './types.js';

export interface StateEntry {
  namespace: string;
  key: string;
  value: JsonValue;
  updated_at: string;
}

interface StateRow extends Omit<StateEntry, 'value'> {
  value: string;
}

function rowToEntry(row: unknown): StateEntry {
  const r = row as StateRow;
  return { ...r, value: JSON.parse(r.value) as JsonValue };
}

/** Everything in the table as `{ [namespace]: { [key]: value } }`; the `state` template scope. */
export type StateSnapshot = Record<string, Record<string, JsonValue>>;

/**
 * The KV store (ARCHITECTURE §4): `state(namespace, key, value)`. Connectors use it through
 * `GET/PUT /v1/state/{ns}/{key}`; tasks read it as `${state.<ns>.<key>}` and write it with
 * `state_updates`.
 */
export class StateStore {
  private readonly getStmt: Statement;
  private readonly putStmt: Statement;
  private readonly deleteStmt: Statement;
  private readonly listStmt: Statement;
  private readonly allStmt: Statement;

  constructor(db: Database) {
    this.getStmt = db.prepare('SELECT * FROM state WHERE namespace = ? AND key = ?');
    this.putStmt = db.prepare(
      `INSERT INTO state (namespace, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.deleteStmt = db.prepare('DELETE FROM state WHERE namespace = ? AND key = ?');
    this.listStmt = db.prepare('SELECT * FROM state WHERE namespace = ? ORDER BY key');
    this.allStmt = db.prepare('SELECT * FROM state ORDER BY namespace, key');
  }

  get(namespace: string, key: string): StateEntry | undefined {
    const row: unknown = this.getStmt.get(namespace, key);
    return row === undefined ? undefined : rowToEntry(row);
  }

  put(namespace: string, key: string, value: JsonValue, updatedAt: string): void {
    this.putStmt.run(namespace, key, JSON.stringify(value), updatedAt);
  }

  /** Returns true when there was something to delete. */
  delete(namespace: string, key: string): boolean {
    return this.deleteStmt.run(namespace, key).changes === 1;
  }

  list(namespace: string): StateEntry[] {
    return this.listStmt.all(namespace).map(rowToEntry);
  }

  snapshot(): StateSnapshot {
    const out: StateSnapshot = {};
    for (const e of this.allStmt.all().map(rowToEntry)) {
      (out[e.namespace] ??= {})[e.key] = e.value;
    }
    return out;
  }
}
