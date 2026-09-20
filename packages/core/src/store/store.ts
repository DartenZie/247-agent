import type { Database } from 'better-sqlite3';

import { CursorStore } from './cursors.js';
import { openDatabase } from './db.js';
import { EventStore } from './events.js';
import { LedgerStore } from './ledger.js';
import { RunStore } from './runs.js';
import { StateStore } from './state.js';
import { WaitStore } from './waits.js';

export interface Store {
  readonly db: Database;
  readonly events: EventStore;
  readonly runs: RunStore;
  readonly cursors: CursorStore;
  readonly state: StateStore;
  readonly waits: WaitStore;
  readonly ledger: LedgerStore;
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
    state: new StateStore(db),
    waits: new WaitStore(db),
    ledger: new LedgerStore(db),
    transaction: <T>(fn: () => T): T => db.transaction(fn).immediate(),
    close: () => {
      db.close();
    },
  };
}
