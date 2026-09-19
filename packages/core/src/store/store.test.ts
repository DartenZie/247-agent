import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from './store.js';
import type { EventRecord, RunStatus } from './types.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-store-'));
  store = openStore(join(dir, 'state.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function event(over: Partial<Omit<EventRecord, 'seq'>> = {}): Omit<EventRecord, 'seq'> {
  n += 1;
  return {
    id: `evt_${String(n)}`,
    type: 'x.y',
    source: 'test',
    ts: '2026-09-19T10:00:00.000Z',
    correlation_id: `cor_${String(n)}`,
    parent_id: null,
    dedup_key: null,
    depth: 0,
    payload: { n },
    ...over,
  };
}

describe('openStore', () => {
  it('migrates an empty file, sets WAL and is idempotent on re-open', () => {
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(store.db.pragma('user_version', { simple: true })).toBe(1);
    expect(store.cursors.get('dispatch')).toBe(0);
    const path = join(dir, 'state.db');
    store.close();
    store = openStore(path);
    expect(store.db.pragma('user_version', { simple: true })).toBe(1);
  });
});

describe('EventStore', () => {
  it('inserts, reads back with parsed payload and lists in seq order', () => {
    const a = store.events.insert(event({ id: 'evt_a' }));
    const b = store.events.insert(event({ id: 'evt_b' }));
    expect(a).toEqual({ inserted: true, seq: 1 });
    expect(b).toEqual({ inserted: true, seq: 2 });
    expect(store.events.getById('evt_a')?.payload).toEqual({ n: expect.any(Number) as number });
    expect(store.events.listAfter(0, 10).map((e) => e.id)).toEqual(['evt_a', 'evt_b']);
    expect(store.events.listAfter(1, 10).map((e) => e.id)).toEqual(['evt_b']);
    expect(store.events.listAfter(0, 1)).toHaveLength(1);
  });

  it('drops a second event with the same dedup_key but never conflicts on NULL keys', () => {
    expect(store.events.insert(event({ dedup_key: 'k' })).inserted).toBe(true);
    expect(store.events.insert(event({ dedup_key: 'k' })).inserted).toBe(false);
    expect(store.events.insert(event()).inserted).toBe(true);
    expect(store.events.insert(event()).inserted).toBe(true);
    expect(store.events.listAfter(0, 10)).toHaveLength(3);
  });
});

describe('RunStore', () => {
  const run = (id: string, task = 't', eventId = 'evt_1') => ({
    id,
    task,
    event_id: eventId,
    correlation_id: 'cor_1',
    created_at: '2026-09-19T10:00:00.000Z',
  });

  beforeEach(() => {
    store.events.insert(event({ id: 'evt_1' }));
  });

  it('inserts one run per (task, event) and rejects unknown events', () => {
    expect(store.runs.insertQueued(run('run_1'))).toBe(true);
    expect(store.runs.insertQueued(run('run_2'))).toBe(false);
    expect(store.runs.insertQueued(run('run_3', 'other'))).toBe(true);
    expect(() => store.runs.insertQueued(run('run_4', 't', 'evt_missing'))).toThrow(/FOREIGN KEY/);
    expect(store.runs.getById('run_1')).toMatchObject({
      status: 'queued',
      attempt: 0,
      result: null,
    });
    expect(store.runs.getByTaskAndEvent('t', 'evt_1')?.id).toBe('run_1');
  });

  it('reports active runs for queued, running and waiting only', () => {
    store.runs.insertQueued(run('run_1'));
    const active: RunStatus[] = ['queued', 'running', 'waiting'];
    const done: RunStatus[] = ['succeeded', 'failed', 'cancelled'];
    for (const s of active) {
      store.runs.setStatus('run_1', s);
      expect(store.runs.hasActive('t')).toBe(true);
    }
    for (const s of done) {
      store.runs.setStatus('run_1', s);
      expect(store.runs.hasActive('t')).toBe(false);
    }
    expect(store.runs.hasActive('nobody')).toBe(false);
  });

  it('patches status fields and lists by status', () => {
    store.runs.insertQueued(run('run_1'));
    store.runs.setStatus('run_1', 'running', { started_at: 't1', attempt: 1 });
    store.runs.setStatus('run_1', 'succeeded', { finished_at: 't2', result: { ok: true } });
    expect(store.runs.getById('run_1')).toMatchObject({
      status: 'succeeded',
      started_at: 't1',
      finished_at: 't2',
      attempt: 1,
      result: { ok: true },
    });
    expect(store.runs.listByStatus('queued')).toEqual([]);
    expect(store.runs.listByStatus('succeeded').map((r) => r.id)).toEqual(['run_1']);
  });
});

describe('transaction', () => {
  it('rolls back everything when the callback throws', () => {
    expect(() =>
      store.transaction(() => {
        store.events.insert(event());
        store.cursors.set('dispatch', 5);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.events.listAfter(0, 10)).toEqual([]);
    expect(store.cursors.get('dispatch')).toBe(0);
  });
});
