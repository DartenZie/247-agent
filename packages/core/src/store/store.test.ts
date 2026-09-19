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
    expect(store.db.pragma('user_version', { simple: true })).toBe(2);
    expect(store.cursors.get('dispatch')).toBe(0);
    const path = join(dir, 'state.db');
    store.close();
    store = openStore(path);
    expect(store.db.pragma('user_version', { simple: true })).toBe(2);
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

describe('StateStore', () => {
  it('puts, gets, lists, deletes and snapshots by namespace', () => {
    expect(store.state.get('email', 'last_uid')).toBeUndefined();
    store.state.put('email', 'last_uid', 41, '2026-09-19T10:00:00.000Z');
    store.state.put('email', 'last_uid', 42, '2026-09-19T10:01:00.000Z');
    store.state.put('email', 'folder', { name: 'INBOX' }, '2026-09-19T10:01:00.000Z');
    store.state.put('chat', 'last_seen', null, '2026-09-19T10:01:00.000Z');
    expect(store.state.get('email', 'last_uid')).toEqual({
      namespace: 'email',
      key: 'last_uid',
      value: 42,
      updated_at: '2026-09-19T10:01:00.000Z',
    });
    expect(store.state.list('email').map((e) => e.key)).toEqual(['folder', 'last_uid']);
    expect(store.state.snapshot()).toEqual({
      email: { last_uid: 42, folder: { name: 'INBOX' } },
      chat: { last_seen: null },
    });
    expect(store.state.delete('email', 'folder')).toBe(true);
    expect(store.state.delete('email', 'folder')).toBe(false);
  });
});

describe('WaitStore', () => {
  it('inserts one wait per run, lists pending/expired/resolved and resolves once', () => {
    const now = '2026-09-19T10:00:00.000Z';
    store.events.insert({
      id: 'evt_1',
      type: 'x',
      source: 't',
      ts: now,
      correlation_id: 'cor_1',
      parent_id: null,
      dedup_key: null,
      depth: 0,
      payload: null,
    });
    store.runs.insertQueued({
      id: 'run_1',
      task: 'a',
      event_id: 'evt_1',
      correlation_id: 'cor_1',
      created_at: now,
    });
    const base = {
      run_id: 'run_1',
      task: 'a',
      type: 'chat.reply',
      filter: 'payload.ok',
      expires_at: '2026-09-19T11:00:00.000Z',
      on_timeout: 'fail' as const,
      resume: { step: 1, steps: [null] },
      created_at: now,
    };
    store.waits.insert({ ...base, type: 'old.type' });
    store.waits.insert(base);
    expect(store.waits.get('run_1')).toEqual({ ...base, outcome: null, event_id: null });
    expect(store.waits.listPending().map((w) => w.run_id)).toEqual(['run_1']);
    expect(store.waits.listExpired('2026-09-19T10:59:59.000Z')).toEqual([]);
    expect(store.waits.listExpired('2026-09-19T11:00:00.000Z').map((w) => w.run_id)).toEqual([
      'run_1',
    ]);
    expect(store.waits.resolve('run_1', 'matched', 'evt_1')).toBe(true);
    expect(store.waits.resolve('run_1', 'timeout', null)).toBe(false);
    expect(store.waits.listPending()).toEqual([]);
    expect(store.waits.listResolved()).toMatchObject([
      { run_id: 'run_1', outcome: 'matched', event_id: 'evt_1' },
    ]);
    expect(store.waits.delete('run_1')).toBe(true);
  });
});
