import type { Database } from 'better-sqlite3';

import { CursorStore } from './cursors.js';
import { openDatabase } from './db.js';
import { EventStore } from './events.js';
import { RunStore } from './runs.js';

export interface Store {
  readonly db: Database;
  readonly events: EventStore;
  readonly runs: RunStore;
  readonly cursors: CursorStore;
  /** Runs `fn` in a `BEGIN IMMEDIATE` transaction (nested calls become savepoints). */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openStore(path: string): Store {
  const db = openDatabase(path);
  return {
    db,
    events: new EventStore(db),
    runs: new RunStore(db),
    cursors: new CursorStore(db),
    transaction: <T>(fn: () => T): T => db.transaction(fn).immediate(),
    close: () => {
      db.close();
    },
  };
}
