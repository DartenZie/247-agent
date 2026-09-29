import type { RetentionPolicy } from '../config/retention.js';
import type { Store } from './store.js';

export interface PurgeCounts {
  runs: number;
  ledger: number;
  events: number;
}

/** Rows deleted per transaction, so a pass over a big backlog never holds the store long. */
const BATCH = 500;

function cutoff(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

/**
 * The database half of a retention pass (ARCHITECTURE §7, `retention:`). Order matters
 * for the foreign keys: a run's ledger rows and wait go first, then the run, and an event
 * only once no run points at it. Active runs (`queued`, `running`, `waiting`) are never
 * touched, nor are events the dispatcher has not passed yet. Each batch is its own short
 * transaction; a crash between batches just leaves the rest for the next pass.
 */
export function purgeStore(store: Store, now: Date, policy: RetentionPolicy): PurgeCounts {
  const counts: PurgeCounts = { runs: 0, ledger: 0, events: 0 };
  if (policy.runsMs !== undefined) {
    const before = cutoff(now, policy.runsMs);
    for (;;) {
      const n = store.transaction(() => {
        const ids = store.runs.listFinishedBefore(before, BATCH);
        counts.ledger += store.ledger.deleteForRuns(ids);
        for (const id of ids) {
          store.waits.delete(id);
        }
        counts.runs += store.runs.deleteByIds(ids);
        return ids.length;
      });
      if (n < BATCH) {
        break;
      }
    }
  }
  if (policy.ledgerMs !== undefined) {
    counts.ledger += store.ledger.deleteBefore(cutoff(now, policy.ledgerMs));
  }
  if (policy.eventsMs !== undefined) {
    const before = cutoff(now, policy.eventsMs);
    for (;;) {
      const n = store.transaction(() =>
        store.events.deleteUnreferencedBefore(before, store.cursors.get('dispatch'), BATCH),
      );
      counts.events += n;
      if (n < BATCH) {
        break;
      }
    }
  }
  return counts;
}
