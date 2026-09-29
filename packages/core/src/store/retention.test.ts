import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { retentionPolicy } from '../config/retention.js';
import { purgeStore } from './retention.js';
import { openStore, type Store } from './store.js';
import type { RunStatus } from './types.js';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-retention-'));
  store = openStore(join(dir, 'state.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function seed(opts: { ts: string; status?: RunStatus; finishedAt?: string; usd?: number }): {
  eventId: string;
  runId: string | undefined;
} {
  n += 1;
  const eventId = `evt_${String(n)}`;
  store.events.insert({
    id: eventId,
    type: 'x.y',
    source: 'test',
    ts: opts.ts,
    correlation_id: `cor_${String(n)}`,
    parent_id: null,
    dedup_key: `k${String(n)}`,
    depth: 0,
    payload: null,
  });
  if (opts.status === undefined) {
    return { eventId, runId: undefined };
  }
  const runId = `run_${String(n)}`;
  store.runs.insertQueued({
    id: runId,
    task: 't',
    event_id: eventId,
    correlation_id: `cor_${String(n)}`,
    created_at: opts.ts,
  });
  store.runs.setStatus(runId, opts.status, {
    ...(opts.finishedAt === undefined ? {} : { finished_at: opts.finishedAt }),
  });
  if (opts.usd !== undefined) {
    store.ledger.insert({
      run_id: runId,
      task: 't',
      provider: 'p',
      model: 'm',
      in_tok: 1,
      out_tok: 1,
      cache_read: 0,
      cache_write: 0,
      usd: opts.usd,
      priced_by: 'table',
      ts: opts.finishedAt ?? opts.ts,
    });
  }
  return { eventId, runId };
}

const policy = (over: Record<string, string> = {}) =>
  retentionPolicy({
    events: '30d',
    runs: '10d',
    workspaces: '7d',
    interval: '1h',
    ...over,
  });

describe('purgeStore', () => {
  it('deletes old finished runs with their ledger rows, then events nothing references', async () => {
    const oldDone = seed({ ts: ago(40), status: 'succeeded', finishedAt: ago(39), usd: 0.5 });
    const oldFailed = seed({ ts: ago(20), status: 'failed', finishedAt: ago(11) });
    const recent = seed({ ts: ago(5), status: 'succeeded', finishedAt: ago(4), usd: 0.1 });
    const running = seed({ ts: ago(50), status: 'running', usd: 0.2 });
    const waiting = seed({ ts: ago(50), status: 'waiting' });
    const loneOld = seed({ ts: ago(31) });
    const loneRecent = seed({ ts: ago(29) });
    // Only dispatched events may go: pretend the cursor passed all but the last.
    store.cursors.set('dispatch', 6);
    const undispatched = seed({ ts: ago(60) });

    const transcript = (runId: string | undefined, text: string) =>
      store.transcripts.append({
        run_id: runId ?? '',
        ts: NOW.toISOString(),
        turn: 1,
        kind: 'text',
        text,
        data: null,
      });
    transcript(oldDone.runId, 'old');
    transcript(oldDone.runId, 'old too');
    transcript(running.runId, 'live');

    const counts = await purgeStore(store, NOW, policy());
    expect(counts).toEqual({ runs: 2, ledger: 1, transcripts: 2, events: 2 });
    expect(store.transcripts.countByRun(oldDone.runId ?? '')).toBe(0);
    expect(store.transcripts.countByRun(running.runId ?? '')).toBe(1);
    expect(store.runs.getById(oldDone.runId ?? '')).toBeUndefined();
    expect(store.runs.getById(oldFailed.runId ?? '')).toBeUndefined();
    expect(store.runs.getById(recent.runId ?? '')?.status).toBe('succeeded');
    expect(store.runs.getById(running.runId ?? '')?.status).toBe('running');
    expect(store.runs.getById(waiting.runId ?? '')?.status).toBe('waiting');
    expect(store.ledger.sumForRun(oldDone.runId ?? '')).toBe(0);
    expect(store.ledger.sumForRun(running.runId ?? '')).toBe(0.2);
    // Events: the old purged run's event and the lone old one went; the failed run's event
    // is unreferenced now but only 20 days old, so it stays until the events cutoff.
    expect(store.events.getById(oldDone.eventId)).toBeUndefined();
    expect(store.events.getById(oldFailed.eventId)).toBeDefined();
    expect(store.events.getById(loneOld.eventId)).toBeUndefined();
    expect(store.events.getById(loneRecent.eventId)).toBeDefined();
    expect(store.events.getById(running.eventId)).toBeDefined();
    expect(store.events.getById(waiting.eventId)).toBeDefined();
    expect(store.events.getById(undispatched.eventId)).toBeDefined();
    expect(store.events.getById(recent.eventId)).toBeDefined();
    // A second pass finds nothing more.
    expect(await purgeStore(store, NOW, policy())).toEqual({
      runs: 0,
      ledger: 0,
      transcripts: 0,
      events: 0,
    });
  });

  it('keeps a run whose event is old and an event whose run is kept, and honours never', async () => {
    const kept = seed({ ts: ago(100), status: 'succeeded', finishedAt: ago(1), usd: 1 });
    seed({ ts: ago(100), status: 'succeeded', finishedAt: ago(50), usd: 1 });
    store.cursors.set('dispatch', 10);
    expect(
      await purgeStore(store, NOW, policy({ runs: 'never', events: 'never', ledger: 'never' })),
    ).toEqual({
      runs: 0,
      ledger: 0,
      transcripts: 0,
      events: 0,
    });
    expect(await purgeStore(store, NOW, policy({ runs: 'never' }))).toEqual({
      runs: 0,
      ledger: 0,
      transcripts: 0,
      events: 0,
    });
    // `ledger` shorter than `runs`: rows go while the run stays.
    expect(await purgeStore(store, NOW, policy({ runs: 'never', ledger: '20d' }))).toEqual({
      runs: 0,
      ledger: 1,
      transcripts: 0,
      events: 0,
    });
    expect(store.ledger.sumForRun(kept.runId ?? '')).toBe(1);
    expect(store.events.getById(kept.eventId)).toBeDefined();
  });

  it('works through more rows than one batch', async () => {
    for (let i = 0; i < 1203; i++) {
      seed({ ts: ago(40), status: 'succeeded', finishedAt: ago(39) });
    }
    store.cursors.set('dispatch', 5000);
    expect(await purgeStore(store, NOW, policy())).toEqual({
      runs: 1203,
      ledger: 0,
      transcripts: 0,
      events: 1203,
    });
    expect(store.runs.list({ limit: 1 })).toEqual([]);
  });

  it('batches the ledger purge and yields to the event loop between batches', async () => {
    const { runId } = seed({ ts: ago(40), status: 'succeeded', finishedAt: ago(39) });
    for (let i = 0; i < 1203; i++) {
      store.ledger.insert({
        run_id: runId ?? '',
        task: 't',
        provider: 'p',
        model: 'm',
        in_tok: 1,
        out_tok: 1,
        cache_read: 0,
        cache_write: 0,
        usd: 0.01,
        priced_by: 'table',
        ts: ago(25),
      });
    }
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 0);
    const counts = await purgeStore(store, NOW, policy({ runs: 'never', ledger: '20d' }));
    clearInterval(tick);
    expect(counts).toEqual({ runs: 0, ledger: 1203, transcripts: 0, events: 0 });
    expect(store.ledger.sumForRun(runId ?? '')).toBe(0);
    expect(ticks).toBeGreaterThan(0);
  });
});
