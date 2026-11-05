import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS } from './migrations.js';
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

/** Writes a database at schema `version`, as an older build would leave it, with one row. */
function atSchema(path: string, version: number): void {
  const db = new Database(path);
  for (const sql of MIGRATIONS.slice(0, version)) {
    db.exec(sql);
  }
  db.pragma(`user_version = ${String(version)}`);
  db.prepare("INSERT INTO cursors (name, seq) VALUES ('kept', 1)").run();
  db.close();
}

/** The `.bak` files in the test directory, sorted. */
function copies(): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.bak'))
    .sort();
}

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
    expect(store.db.pragma('user_version', { simple: true })).toBe(13);
    expect(store.cursors.get('dispatch')).toBe(0);
    const path = join(dir, 'state.db');
    store.close();
    store = openStore(path);
    expect(store.db.pragma('user_version', { simple: true })).toBe(13);
  });

  it('refuses a database whose schema is newer than this build', () => {
    const path = join(dir, 'state.db');
    store.db.pragma('user_version = 14');
    store.close();
    expect(() => (store = openStore(path))).toThrow(
      /schema version 14 is newer than this build's 13/,
    );
    store = openStore(join(dir, 'other.db'));
    const db = new Database(path);
    expect(db.pragma('user_version', { simple: true })).toBe(14);
    db.close();
  });

  it('copies a database to <path>.schema-<n>.bak before it migrates it', () => {
    const prev = process.umask(0o022);
    try {
      const path = join(dir, 'old.db');
      atSchema(path, 8);
      writeFileSync(`${path}.schema-7.bak`, 'an older copy');
      writeFileSync(`${path}.schema-7-mine.bak`, "the operator's own copy");
      const migrated = openStore(path);
      migrated.close();
      expect(copies()).toEqual(['old.db.schema-7-mine.bak', 'old.db.schema-8.bak']);
      const copy = new Database(`${path}.schema-8.bak`, { readonly: true });
      expect(copy.pragma('user_version', { simple: true })).toBe(8);
      expect(copy.prepare("SELECT seq FROM cursors WHERE name = 'kept'").pluck().get()).toBe(1);
      copy.close();
      expect(statSync(`${path}.schema-8.bak`).mode & 0o777).toBe(0o640);
    } finally {
      process.umask(prev);
    }
  });

  it('keeps the ledger rows and accepts priced_by estimate after migrating from schema 11', () => {
    const path = join(dir, 'old.db');
    atSchema(path, 11);
    const db = new Database(path);
    db.exec(`
      INSERT INTO events (id, type, source, ts, correlation_id, payload)
        VALUES ('evt_1', 'x.y', 'test', '2026-09-19T10:00:00.000Z', 'cor_1', '{}');
      INSERT INTO runs (id, task, event_id, correlation_id, status, created_at)
        VALUES ('run_1', 't', 'evt_1', 'cor_1', 'running', '2026-09-19T10:00:00.000Z');
      INSERT INTO ledger (run_id, task, provider, model, in_tok, out_tok, usd, priced_by, ts)
        VALUES ('run_1', 't', 'anthropic', 'claude-haiku-4-5', 10, 1, 0.5, 'table', '2026-09-19T10:00:00.000Z');
      INSERT INTO ledger (run_id, task, provider, model, in_tok, out_tok, usd, priced_by, ts)
        VALUES ('run_1', 't', 'anthropic', 'claude-haiku-4-5', 10, 1, 0.5, 'table', '2026-09-19T10:00:00.000Z');
      DELETE FROM ledger WHERE id = 2;
    `);
    db.close();
    const migrated = openStore(path);
    try {
      // Ids keep counting past a row retention removed: event payloads name ledger ids.
      const id = migrated.ledger.insert({
        run_id: 'run_1',
        task: 't',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        in_tok: 5,
        out_tok: 100,
        cache_read: 0,
        cache_write: 0,
        usd: 0.25,
        priced_by: 'estimate',
        ts: '2026-09-19T10:01:00.000Z',
      });
      expect(id).toBe(3);
      expect(migrated.ledger.listByRun('run_1').map((r) => r.priced_by)).toEqual([
        'table',
        'estimate',
      ]);
      expect(migrated.ledger.sumForRun('run_1')).toBeCloseTo(0.75);
      expect(() =>
        migrated.db
          .prepare(
            "INSERT INTO ledger (run_id, task, provider, model, in_tok, out_tok, usd, priced_by, ts) VALUES ('run_1', 't', 'p', 'm', 0, 0, 0, 'guess', 'x')",
          )
          .run(),
      ).toThrow(/CHECK constraint/);
    } finally {
      migrated.close();
    }
  });

  it('makes no copy of a new or a current database', () => {
    const path = join(dir, 'state.db');
    store.close();
    store = openStore(path);
    expect(copies()).toEqual([]);
  });

  it('keeps the copy the release before needs when a migration fails, across restarts', () => {
    const path = join(dir, 'old.db');
    atSchema(path, 7);
    const db = new Database(path);
    db.exec('ALTER TABLE runs ADD COLUMN config TEXT');
    db.close();
    for (let i = 0; i < 2; i += 1) {
      expect(() => openStore(path)).toThrow(/duplicate column name: config/);
    }
    const after = new Database(path, { readonly: true });
    expect(after.pragma('user_version', { simple: true })).toBe(7);
    after.close();
    expect(copies()).toEqual(['old.db.schema-7.bak']);
  });

  it('refuses to migrate a database it cannot copy', () => {
    const path = join(dir, 'old.db');
    atSchema(path, 8);
    mkdirSync(`${path}.schema-8.bak`);
    expect(() => openStore(path)).toThrow(/copy .*old\.db\.schema-8\.bak/);
    const db = new Database(path, { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(8);
    db.close();
    expect(existsSync(`${path}.schema-8.bak`)).toBe(true);
  });

  it('creates the database and its WAL files closed to other users under a permissive umask', () => {
    const prev = process.umask(0o022);
    try {
      const path = join(dir, 'fresh.db');
      const fresh = openStore(path);
      fresh.events.insert(event());
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        expect(statSync(file).mode & 0o007, file).toBe(0);
      }
      fresh.close();
    } finally {
      process.umask(prev);
    }
  });

  it('closes an existing world-readable database to other users on open', () => {
    const path = join(dir, 'state.db');
    store.close();
    chmodSync(path, 0o644);
    store = openStore(path);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });
});

describe('Store.probeWrite', () => {
  it('commits the health cursor and gives up on a held lock within 250 ms', () => {
    store.probeWrite(1234);
    expect(store.cursors.get('health')).toBe(1234);
    const other = new Database(join(dir, 'state.db'));
    try {
      other.exec('BEGIN IMMEDIATE');
      const started = Date.now();
      expect(() => {
        store.probeWrite(5678);
      }).toThrow(/locked/);
      expect(Date.now() - started).toBeLessThan(2000);
      other.exec('ROLLBACK');
    } finally {
      other.close();
    }
    expect(store.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    store.probeWrite(5678);
    expect(store.cursors.get('health')).toBe(5678);
  });
});

describe('Store.backup', () => {
  it('copies a consistent database while other writes go on, as a 0600 file', async () => {
    for (let i = 0; i < 2000; i++) {
      store.cursors.set(`c${String(i)}`, i);
    }
    const copy = join(dir, 'copy.db');
    const done = store.backup(copy);
    store.cursors.set('during', 1);
    await done;
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    const db = new Database(copy, { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      expect(
        (db.prepare('SELECT count(*) AS n FROM cursors').get() as { n: number }).n,
      ).toBeGreaterThanOrEqual(2000);
    } finally {
      db.close();
    }
  });

  it('refuses a file that exists', async () => {
    const copy = join(dir, 'copy.db');
    writeFileSync(copy, 'old');
    await expect(store.backup(copy)).rejects.toThrow(/EEXIST/);
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

  it('lists the events of a type or pattern in a seq range, in seq order (#101)', () => {
    const types = ['chat.reply', 'chat.a.reply', 'chat', 'chatx.reply', 'mail.reply', 'chat.reply'];
    for (const type of types) {
      store.events.insert(event({ id: `evt_${type}_${String(n)}`, type }));
    }
    const seqs = (pattern: string, after = 0, upTo = 99, limit = 10) =>
      store.events.listOfType(pattern, after, upTo, limit).map((e) => e.seq);
    expect(seqs('chat.reply')).toEqual([1, 6]);
    expect(seqs('chat.*')).toEqual([1, 6]);
    expect(seqs('chat.*.reply')).toEqual([2]);
    expect(seqs('*.reply')).toEqual([1, 4, 5, 6]);
    expect(seqs('*.reply', 1, 5)).toEqual([4, 5]);
    expect(seqs('*.reply', 0, 99, 2)).toEqual([1, 4]);
    expect(seqs('chat.*', 1, 5)).toEqual([]);
  });
});

describe('WaitStore.revision', () => {
  it('moves on every wait change and when a transaction rolls back (#101)', () => {
    const r0 = store.waits.revision;
    expect(store.waits.listPending()).toEqual([]);
    expect(store.waits.revision).toBe(r0);
    expect(() =>
      store.transaction(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.waits.revision).toBeGreaterThan(r0);
    const r1 = store.waits.revision;
    store.waits.delete('run_none');
    expect(store.waits.revision).toBeGreaterThan(r1);
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

  it('keeps the first started_at and clears the error only on an explicit null (#88)', () => {
    store.runs.insertQueued(run('run_1'));
    store.runs.setStatus('run_1', 'running', { started_at: 't1', attempt: 1 });
    store.runs.setStatus('run_1', 'running', { error: 'boom' });
    store.runs.setStatus('run_1', 'running', { started_at: 't2', attempt: 2 });
    expect(store.runs.getById('run_1')).toMatchObject({ started_at: 't1', error: 'boom' });
    store.runs.setStatus('run_1', 'succeeded', { finished_at: 't3', error: null });
    expect(store.runs.getById('run_1')).toMatchObject({ started_at: 't1', error: null });
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
      consumed: ['evt_1'],
    };
    store.waits.insert({ ...base, type: 'old.type' });
    store.waits.insert(base);
    expect(store.waits.get('run_1')).toEqual({ ...base, outcome: null, event_id: null });
    expect(store.waits.listPending().map((w) => w.run_id)).toEqual(['run_1']);
    expect(store.waits.countPending()).toBe(1);
    expect(store.waits.listExpired('2026-09-19T10:59:59.000Z')).toEqual([]);
    expect(store.waits.listExpired('2026-09-19T11:00:00.000Z').map((w) => w.run_id)).toEqual([
      'run_1',
    ]);
    expect(store.waits.resolve('run_1', 'matched', 'evt_1')).toBe(true);
    expect(store.waits.resolve('run_1', 'timeout', null)).toBe(false);
    expect(store.waits.listPending()).toEqual([]);
    expect(store.waits.countPending()).toBe(0);
    expect(store.waits.listResolved()).toMatchObject([
      { run_id: 'run_1', outcome: 'matched', event_id: 'evt_1' },
    ]);
    expect(store.waits.delete('run_1')).toBe(true);
  });
});

describe('LedgerStore', () => {
  const row = (over: Partial<Parameters<typeof store.ledger.insert>[0]> = {}) => ({
    run_id: 'run_1',
    task: 'classify',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    in_tok: 1000,
    out_tok: 100,
    cache_read: 0,
    cache_write: 0,
    usd: 0.0015,
    priced_by: 'table' as const,
    ts: '2026-09-19T10:00:00.000Z',
    ...over,
  });

  beforeEach(() => {
    for (const id of ['run_1', 'run_2']) {
      store.events.insert(event({ id: `evt_${id}` }));
      store.runs.insertQueued({
        id,
        task: 'classify',
        event_id: `evt_${id}`,
        correlation_id: 'cor_l',
        created_at: '2026-09-19T10:00:00.000Z',
      });
    }
  });

  it('inserts rows, sums by run and since a timestamp, and lists by run', () => {
    expect(store.ledger.insert(row())).toBe(1);
    store.ledger.insert(row({ run_id: 'run_2', usd: 0.5, ts: '2026-09-20T01:00:00.000Z' }));
    store.ledger.insert(row({ usd: 0.25, ts: '2026-09-18T23:59:59.000Z', priced_by: 'provider' }));
    expect(store.ledger.sumForRun('run_1')).toBeCloseTo(0.2515);
    expect(store.ledger.sumForRun('run_x')).toBe(0);
    expect(store.ledger.sumSince('2026-09-19T00:00:00.000Z')).toBeCloseTo(0.5015);
    expect(store.ledger.listByRun('run_1').map((r) => r.priced_by)).toEqual(['table', 'provider']);
    expect(() => store.ledger.insert(row({ run_id: 'run_missing' }))).toThrow(/FOREIGN KEY/);
  });

  it('summarises by task, model, provider and day', () => {
    store.ledger.insert(row());
    store.ledger.insert(
      row({ run_id: 'run_2', task: 'other', model: 'claude-sonnet-5', usd: 0.5 }),
    );
    store.ledger.insert(row({ usd: 0.25, ts: '2026-09-20T01:00:00.000Z' }));
    const since = '2026-09-01T00:00:00.000Z';
    expect(store.ledger.summary({ since, by: 'task' })).toEqual([
      {
        key: 'other',
        calls: 1,
        in_tok: 1000,
        out_tok: 100,
        cache_read: 0,
        cache_write: 0,
        usd: 0.5,
        priced_by: { table: 1, provider: 0, estimate: 0, unpriced: 0 },
      },
      {
        key: 'classify',
        calls: 2,
        in_tok: 2000,
        out_tok: 200,
        cache_read: 0,
        cache_write: 0,
        usd: expect.closeTo(0.2515, 6) as number,
        priced_by: { table: 2, provider: 0, estimate: 0, unpriced: 0 },
      },
    ]);
    expect(store.ledger.summary({ since, by: 'model' }).map((r) => r.key)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    expect(store.ledger.summary({ since, by: 'provider' })).toHaveLength(1);
    expect(store.ledger.summary({ since, by: 'day' }).map((r) => [r.key, r.calls])).toEqual([
      ['2026-09-19', 2],
      ['2026-09-20', 1],
    ]);
    expect(store.ledger.summary({ since: '2026-09-20T00:00:00.000Z', by: 'day' })).toHaveLength(1);
  });

  it('sums cache writes and counts the calls of each pricing source per group (#129)', () => {
    store.ledger.insert(row({ cache_read: 300, cache_write: 700 }));
    store.ledger.insert(row({ cache_write: 50, usd: 0, priced_by: 'unpriced' }));
    store.ledger.insert(row({ priced_by: 'provider' }));
    store.ledger.insert(row({ run_id: 'run_2', priced_by: 'estimate' }));
    expect(store.ledger.summary({ since: '2026-09-01T00:00:00.000Z', by: 'task' })).toEqual([
      expect.objectContaining({
        key: 'classify',
        calls: 4,
        cache_read: 300,
        cache_write: 750,
        priced_by: { table: 1, provider: 1, estimate: 1, unpriced: 1 },
      }),
    ]);
  });
});

describe('EventStore.list', () => {
  it('returns the newest events in seq order, filtered by type or pattern, or those after a seq', () => {
    for (const type of ['a.x', 'a.y', 'b.x', 'a.x']) {
      store.events.insert(event({ type }));
    }
    const types = (events: EventRecord[]) => events.map((e) => `${String(e.seq)}:${e.type}`);
    expect(types(store.events.list())).toEqual(['1:a.x', '2:a.y', '3:b.x', '4:a.x']);
    expect(types(store.events.list({ limit: 2 }))).toEqual(['3:b.x', '4:a.x']);
    expect(types(store.events.list({ type: 'a.x' }))).toEqual(['1:a.x', '4:a.x']);
    expect(types(store.events.list({ type: 'a.*', limit: 2 }))).toEqual(['2:a.y', '4:a.x']);
    expect(types(store.events.list({ type: '*.x' }))).toEqual(['1:a.x', '3:b.x', '4:a.x']);
    expect(types(store.events.list({ after: 1 }))).toEqual(['2:a.y', '3:b.x', '4:a.x']);
    expect(types(store.events.list({ after: 1, type: 'a.*', limit: 1 }))).toEqual(['2:a.y']);
    expect(store.events.list({ after: 4 })).toEqual([]);
  });
});

describe('TranscriptStore', () => {
  it('appends entries per run in order, pages after an id and counts them', () => {
    store.events.insert(event({ id: 'evt_t' }));
    for (const id of ['run_a', 'run_b']) {
      store.runs.insertQueued({
        id,
        task: id,
        event_id: 'evt_t',
        correlation_id: 'cor_t',
        created_at: '2026-09-29T10:00:00.000Z',
      });
    }
    const base = { run_id: 'run_a', ts: '2026-09-29T10:00:00.000Z', turn: 1 as const };
    const first = store.transcripts.append({ ...base, kind: 'prompt', text: 'do it', data: null });
    store.transcripts.append({
      ...base,
      kind: 'tool_call',
      text: null,
      data: { id: 'call_1', command: 'npm run build' },
    });
    store.transcripts.append({ ...base, run_id: 'run_b', kind: 'text', text: 'other', data: null });
    const a = store.transcripts.listByRun('run_a');
    expect(a).toMatchObject([
      { id: first, kind: 'prompt', text: 'do it', data: null },
      { kind: 'tool_call', text: null, data: { id: 'call_1', command: 'npm run build' } },
    ]);
    expect(store.transcripts.listByRun('run_a', { after: first })).toMatchObject([
      { kind: 'tool_call' },
    ]);
    expect(store.transcripts.listByRun('run_a', { limit: 1 })).toHaveLength(1);
    expect(store.transcripts.countByRun('run_a')).toBe(2);
    expect(store.transcripts.countByRun('run_b')).toBe(1);
    expect(store.transcripts.listByRun('run_c')).toEqual([]);
    expect(() =>
      store.transcripts.append({ ...base, run_id: 'run_c', kind: 'text', text: 'x', data: null }),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('RunAttemptStore', () => {
  beforeEach(() => {
    store.events.insert(event({ id: 'evt_a' }));
    store.runs.insertQueued({
      id: 'run_a',
      task: 't',
      event_id: 'evt_a',
      correlation_id: 'cor_a',
      created_at: '2026-09-19T10:00:00.000Z',
    });
  });

  it('records each attempt with its times, status, error and output, in order', () => {
    store.attempts.start('run_a', 1, 't1');
    store.attempts.setOutput('run_a', 1, { stdout: 'out', stderr: 'err' });
    store.attempts.end('run_a', 1, { status: 'failed', finished_at: 't2', error: 'boom' });
    store.attempts.start('run_a', 2, 't3');
    expect(store.attempts.listByRun('run_a')).toEqual([
      {
        run_id: 'run_a',
        attempt: 1,
        status: 'failed',
        started_at: 't1',
        finished_at: 't2',
        error: 'boom',
        stdout: 'out',
        stderr: 'err',
      },
      {
        run_id: 'run_a',
        attempt: 2,
        status: 'running',
        started_at: 't3',
        finished_at: null,
        error: null,
        stdout: null,
        stderr: null,
      },
    ]);
    expect(store.attempts.get('run_a', 2)?.status).toBe('running');
    expect(store.attempts.get('run_a', 3)).toBeUndefined();
    expect(() => {
      store.attempts.start('run_missing', 1, 't1');
    }).toThrow(/FOREIGN KEY/);
  });

  it('continues an attempt that resumes after a wait, and replaces one that runs again', () => {
    store.attempts.start('run_a', 1, 't1');
    store.attempts.setOutput('run_a', 1, { stdout: 'asked', stderr: null });
    store.attempts.end('run_a', 1, { status: 'waiting', finished_at: null, error: null });
    store.attempts.start('run_a', 1, 't2', { resume: true });
    expect(store.attempts.get('run_a', 1)).toMatchObject({
      status: 'running',
      started_at: 't1',
      stdout: 'asked',
    });
    store.attempts.closeOpen('run_a', { status: 'interrupted', finished_at: 't3', error: null });
    store.attempts.start('run_a', 1, 't4');
    expect(store.attempts.get('run_a', 1)).toMatchObject({
      status: 'running',
      started_at: 't4',
      finished_at: null,
      stdout: null,
    });
  });

  it('closes only the attempts still open, and deletes the attempts of runs for retention', () => {
    store.attempts.start('run_a', 1, 't1');
    store.attempts.end('run_a', 1, { status: 'failed', finished_at: 't2', error: 'first' });
    store.attempts.start('run_a', 2, 't3');
    store.attempts.closeOpen('run_a', { status: 'succeeded', finished_at: 't4', error: null });
    expect(
      store.attempts.listByRun('run_a').map((a) => [a.status, a.finished_at, a.error]),
    ).toEqual([
      ['failed', 't2', 'first'],
      ['succeeded', 't4', null],
    ]);
    expect(store.attempts.deleteForRuns(['run_a'])).toBe(2);
    expect(store.attempts.listByRun('run_a')).toEqual([]);
  });
});
