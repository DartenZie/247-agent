import type { RetentionPolicy } from '../config/retention.js';
import type { Store } from './store.js';

export interface PurgeCounts {
  runs: number;
  ledger: number;
  transcripts: number;
  events: number;
}

/** Rows deleted per transaction, so a pass over a big backlog never holds the store long. */
const BATCH = 500;

/** Lets timers, sockets and the dispatcher run between two batches. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Runs `batch` (one transaction) until it deletes fewer than `BATCH` rows; the total. */
async function drain(store: Store, batch: () => number): Promise<number> {
  let total = 0;
  for (;;) {
    const n = store.transaction(batch);
    total += n;
    if (n < BATCH) {
      return total;
    }
    await yieldToLoop();
  }
}

function cutoff(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

/**
 * The database half of a retention pass (ARCHITECTURE §7, `retention:`). Order matters
 * for the foreign keys: a run's ledger rows, transcript and wait go first, then the run, and an event
 * only once no run points at it. Active runs (`queued`, `running`, `waiting`) are never
 * touched, nor are events the dispatcher has not passed yet. Each batch is its own short
 * transaction and the event loop gets a turn between batches, so a big backlog (the first
 * pass after an upgrade) never stalls the API or dispatch; a crash between batches just
 * leaves the rest for the next pass.
 */
export async function purgeStore(
  store: Store,
  now: Date,
  policy: RetentionPolicy,
): Promise<PurgeCounts> {
  const counts: PurgeCounts = { runs: 0, ledger: 0, transcripts: 0, events: 0 };
  if (policy.runsMs !== undefined) {
    const before = cutoff(now, policy.runsMs);
    await drain(store, () => {
      const ids = store.runs.listFinishedBefore(before, BATCH);
      counts.ledger += store.ledger.deleteForRuns(ids);
      counts.transcripts += store.transcripts.deleteForRuns(ids);
      for (const id of ids) {
        store.waits.delete(id);
      }
      counts.runs += store.runs.deleteByIds(ids);
      return ids.length;
    });
  }
  if (policy.ledgerMs !== undefined) {
    const before = cutoff(now, policy.ledgerMs);
    counts.ledger += await drain(store, () => store.ledger.deleteBefore(before, BATCH));
  }
  if (policy.eventsMs !== undefined) {
    const before = cutoff(now, policy.eventsMs);
    counts.events += await drain(store, () =>
      store.events.deleteUnreferencedBefore(before, store.cursors.get('dispatch'), BATCH),
    );
  }
  return counts;
}
