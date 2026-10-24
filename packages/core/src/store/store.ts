import type { Database } from 'better-sqlite3';

import { BatchStore } from './batches.js';
import { CursorStore } from './cursors.js';
import { openDatabase } from './db.js';
import { EventStore } from './events.js';
import { LedgerStore } from './ledger.js';
import { PauseStore } from './pauses.js';
import { RunStore } from './runs.js';
import { StateStore } from './state.js';
import { TranscriptStore } from './transcripts.js';
import { WaitStore } from './waits.js';

export interface Store {
  readonly db: Database;
  readonly events: EventStore;
  readonly runs: RunStore;
  readonly cursors: CursorStore;
  readonly state: StateStore;
  readonly waits: WaitStore;
  readonly ledger: LedgerStore;
  readonly transcripts: TranscriptStore;
  /** `llm` requests submitted to a Message Batches API and not settled yet. */
  readonly batches: BatchStore;
  /** Tasks paused with `oa tasks pause`. */
  readonly pauses: PauseStore;
  /** Runs `fn` in a `BEGIN IMMEDIATE` transaction (nested calls become savepoints). */
  transaction<T>(fn: () => T): T;
  /**
   * Commits one tiny write (the `health` cursor, set to `at` in epoch ms) and throws what
   * SQLite throws: a read-only file, a full disk, a lock held past 250 ms. The short wait
   * keeps a lock held elsewhere from stalling the event loop on every health poll.
   */
  probeWrite(at: number): void;
  close(): void;
}

export function openStore(path: string): Store {
  const db = openDatabase(path);
  const cursors = new CursorStore(db);
  return {
    db,
    events: new EventStore(db),
    runs: new RunStore(db),
    cursors,
    state: new StateStore(db),
    waits: new WaitStore(db),
    ledger: new LedgerStore(db),
    transcripts: new TranscriptStore(db),
    batches: new BatchStore(db),
    pauses: new PauseStore(db),
    transaction: <T>(fn: () => T): T => db.transaction(fn).immediate(),
    probeWrite: (at) => {
      const busy = db.pragma('busy_timeout', { simple: true }) as number;
      db.pragma('busy_timeout = 250');
      try {
        db.transaction(() => {
          cursors.set('health', at);
        }).immediate();
      } finally {
        db.pragma(`busy_timeout = ${String(busy)}`);
      }
    },
    close: () => {
      db.close();
    },
  };
}
