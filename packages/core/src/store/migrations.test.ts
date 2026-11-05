import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS } from './migrations.js';
import { openStore } from './store.js';

/**
 * Rows a build at each schema version could have written, one entry per migration:
 * `SEEDS[i]` runs right after `MIGRATIONS[i]`, against the schema it leaves. It fills
 * what that migration added (a table, a column, an index's table), so an upgrade from any
 * earlier version is tested with data in every table that version had. A new migration
 * needs a new entry here; the first test fails until it has one.
 */
const SEEDS: readonly string[] = [
  // 1: events, runs, cursors.
  `
  INSERT INTO events (id, type, source, ts, correlation_id, parent_id, dedup_key, depth, payload)
    VALUES ('evt_1', 'mail.received', 'email', '2026-01-01T00:00:00.000Z', 'cor_1', NULL, 'mail:1', 0, '{"subject":"hi"}'),
           ('evt_2', 'mail.triaged', 'task:triage', '2026-01-01T00:00:01.000Z', 'cor_1', 'evt_1', NULL, 1, '{"label":"urgent"}');
  INSERT INTO runs (id, task, event_id, correlation_id, status, attempt, created_at, started_at, finished_at, result, error)
    VALUES ('run_1', 'triage', 'evt_1', 'cor_1', 'succeeded', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.100Z', '2026-01-01T00:00:01.000Z', '{"ok":true}', NULL),
           ('run_2', 'approve', 'evt_2', 'cor_1', 'waiting', 1, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.100Z', NULL, NULL, NULL),
           ('run_3', 'notify', 'evt_2', 'cor_1', 'failed', 3, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.200Z', '2026-01-01T00:00:02.000Z', NULL, 'exit 1');
  UPDATE cursors SET seq = 2 WHERE name = 'dispatch';
  INSERT INTO cursors (name, seq) VALUES ('connector:email', 41);
  `,
  // 2: state, waits.
  `
  INSERT INTO state (namespace, key, value, updated_at)
    VALUES ('triage', 'last_uid', '41', '2026-01-01T00:00:01.000Z'),
           ('triage', 'seen', '{"mail:1":true}', '2026-01-01T00:00:01.000Z');
  INSERT INTO waits (run_id, task, type, filter, expires_at, on_timeout, resume, created_at, outcome, event_id)
    VALUES ('run_2', 'approve', 'approval.given', 'event.payload.ok', '2026-01-02T00:00:00.000Z', 'fail', '{"step":1}', '2026-01-01T00:00:01.100Z', NULL, NULL);
  `,
  // 3: ledger. Retention removed the newest row, so the id counter is ahead of max(id).
  `
  INSERT INTO ledger (run_id, task, provider, model, in_tok, out_tok, cache_read, cache_write, usd, priced_by, ts)
    VALUES ('run_1', 'triage', 'anthropic', 'claude-haiku-4-5', 1200, 80, 1000, 200, 0.0042, 'table', '2026-01-01T00:00:00.500Z'),
           ('run_1', 'triage', 'openrouter', 'typesafe/jev-1.13', 300, 0, 0, 0, 0.0001, 'provider', '2026-01-01T00:00:00.600Z'),
           ('run_3', 'notify', 'local', 'llama', 10, 10, 0, 0, 0, 'unpriced', '2026-01-01T00:00:01.500Z'),
           ('run_3', 'notify', 'local', 'llama', 1, 1, 0, 0, 0, 'unpriced', '2026-01-01T00:00:01.600Z');
  DELETE FROM ledger WHERE ts = '2026-01-01T00:00:01.600Z';
  `,
  // 4: indexes on runs(event_id) and waits(event_id); a resolved wait exercises the latter.
  `
  INSERT INTO events (id, type, source, ts, correlation_id, parent_id, depth, payload)
    VALUES ('evt_3', 'approval.given', 'manual', '2026-01-01T00:00:03.000Z', 'cor_1', 'evt_2', 2, '{"ok":true}');
  INSERT INTO runs (id, task, event_id, correlation_id, status, attempt, created_at, started_at)
    VALUES ('run_4', 'approve', 'evt_3', 'cor_1', 'waiting', 1, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.100Z');
  INSERT INTO waits (run_id, task, type, filter, expires_at, on_timeout, resume, created_at, outcome, event_id)
    VALUES ('run_4', 'approve', 'approval.given', NULL, NULL, 'succeed', '{"step":2}', '2026-01-01T00:00:03.100Z', 'matched', 'evt_3');
  `,
  // 5: transcripts.
  `
  INSERT INTO transcripts (run_id, ts, turn, kind, text, data)
    VALUES ('run_1', '2026-01-01T00:00:00.700Z', 0, 'message', 'Looking at the mail.', NULL),
           ('run_1', '2026-01-01T00:00:00.800Z', 1, 'tool_call', NULL, '{"tool":"read","path":"a.txt"}');
  `,
  // 6: llm_batches.
  `
  INSERT INTO llm_batches (batch_id, run_id, task, attempt, provider, model, structured, worst_usd, submitted_at)
    VALUES ('msgbatch_1', 'run_2', 'approve', 1, 'anthropic', 'claude-sonnet-5', 1, 0.12, '2026-01-01T00:00:01.300Z');
  `,
  // 7: waits.consumed.
  `
  UPDATE waits SET consumed = '["evt_9"]' WHERE run_id = 'run_2';
  `,
  // 8: runs.progress.
  `
  UPDATE runs SET progress = '{"next":2,"steps":{"a":{"ok":true}}}' WHERE id = 'run_2';
  `,
  // 9: runs.config.
  `
  UPDATE runs SET config = '{"name":"approve","action":{"kind":"wait"}}' WHERE id = 'run_2';
  `,
  // 10: task_pauses.
  `
  INSERT INTO task_pauses (task, paused_at) VALUES ('notify', '2026-01-01T00:00:04.000Z');
  `,
  // 11: events.root_id; rows from before it keep NULL.
  `
  INSERT INTO events (id, type, source, ts, correlation_id, parent_id, depth, payload, root_id)
    VALUES ('evt_4', 'mail.received', 'email', '2026-01-01T00:00:05.000Z', 'cor_4', NULL, 0, '{}', 'evt_4');
  `,
  // 12: ledger rebuilt for priced_by 'estimate'; another deleted newest row.
  `
  INSERT INTO ledger (run_id, task, provider, model, in_tok, out_tok, usd, priced_by, ts)
    VALUES ('run_2', 'approve', 'anthropic', 'claude-sonnet-5', 50, 4000, 0.06, 'estimate', '2026-01-01T00:00:05.000Z'),
           ('run_2', 'approve', 'anthropic', 'claude-sonnet-5', 1, 1, 0.01, 'table', '2026-01-01T00:00:05.500Z');
  DELETE FROM ledger WHERE ts = '2026-01-01T00:00:05.500Z';
  `,
  // 13: run_attempts.
  `
  INSERT INTO run_attempts (run_id, attempt, status, started_at, finished_at, error, stdout, stderr)
    VALUES ('run_3', 1, 'failed', '2026-01-01T00:00:01.200Z', '2026-01-01T00:00:01.300Z', 'exit 1', 'partial', 'boom'),
           ('run_3', 3, 'interrupted', '2026-01-01T00:00:01.800Z', NULL, NULL, NULL, NULL);
  `,
];

/**
 * Columns a later migration adds to an existing table, with the value rows written before
 * it must read. A migration that adds a column to an existing table adds it here.
 */
const ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  events: { root_id: null },
  runs: { progress: null, config: null },
  waits: { consumed: '[]' },
};

/** The indexes of the current schema, as `<table>.<index>`. A migration that adds one adds it here. */
const INDEXES: readonly string[] = [
  'events.events_correlation',
  'events.events_root',
  'events.events_type_seq',
  'ledger.ledger_run',
  'ledger.ledger_task_ts',
  'ledger.ledger_ts',
  'llm_batches.llm_batches_run',
  'runs.runs_event',
  'runs.runs_status_created',
  'runs.runs_task_status',
  'transcripts.transcripts_run',
  'waits.waits_event',
  'waits.waits_expires',
  'waits.waits_type',
];

type Row = Record<string, unknown>;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-migrate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a database at schema `version` as the builds before it would leave it, with rows. */
function seededAt(path: string, version: number): void {
  const db = new Database(path);
  for (let i = 0; i < version; i += 1) {
    db.exec(MIGRATIONS[i] ?? '');
    db.exec(SEEDS[i] ?? '');
  }
  db.pragma(`user_version = ${String(version)}`);
  db.close();
}

function tables(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[];
}

/** Every row of every table, sorted, so a rebuilt table's new rowid order does not matter. */
function contents(db: Database.Database): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const table of tables(db)) {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Row[];
    out[table] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name);
}

/** Tables, indexes and their SQL, as `sqlite_master` lists them. */
function schema(db: Database.Database): unknown[] {
  return db
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
    .all();
}

function readonly(path: string, fn: (db: Database.Database) => void): void {
  const db = new Database(path, { readonly: true });
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe('migrations with data', () => {
  it('has a seed for every migration', () => {
    expect(SEEDS).toHaveLength(MIGRATIONS.length);
    for (const seed of SEEDS) {
      expect(seed.trim()).not.toBe('');
    }
  });

  const versions = Array.from({ length: MIGRATIONS.length - 1 }, (_, i) => i + 1);

  it.each(versions)('keeps every row when upgrading from schema %i', (version) => {
    const path = join(dir, 'old.db');
    seededAt(path, version);
    let before: Record<string, Row[]> = {};
    const beforeColumns: Record<string, string[]> = {};
    readonly(path, (db) => {
      before = contents(db);
      for (const table of Object.keys(before)) {
        beforeColumns[table] = columnsOf(db, table);
      }
    });

    openStore(path).close();

    readonly(path, (db) => {
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const after = contents(db);
      for (const [table, rows] of Object.entries(before)) {
        const added = ADDED_COLUMNS[table] ?? {};
        const old = beforeColumns[table] ?? [];
        const columns = columnsOf(db, table);
        const dropped = old.filter((c) => !columns.includes(c));
        expect(dropped, `${table}: columns the upgrade dropped`).toEqual([]);
        const unknown = columns.filter((c) => !old.includes(c) && !(c in added));
        expect(unknown, `${table}: columns added without an ADDED_COLUMNS entry`).toEqual([]);
        const expected = rows
          .map((row) => {
            const full: Row = {};
            for (const c of columns) {
              full[c] = old.includes(c) ? row[c] : added[c];
            }
            return full;
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        expect(after[table], table).toEqual(expected);
      }
    });
  });

  it.each(versions)('has every index after upgrading from schema %i', (version) => {
    const path = join(dir, 'old.db');
    seededAt(path, version);
    openStore(path).close();
    readonly(path, (db) => {
      expect(
        db
          .prepare(
            "SELECT tbl_name || '.' || name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY 1",
          )
          .pluck()
          .all(),
      ).toEqual(INDEXES);
    });
  });

  it.each(versions)(
    'leaves the schema of a new database when upgrading from schema %i',
    (version) => {
      const path = join(dir, 'old.db');
      seededAt(path, version);
      openStore(path).close();
      const fresh = join(dir, 'fresh.db');
      openStore(fresh).close();

      let want: unknown[] = [];
      readonly(fresh, (db) => {
        want = schema(db);
      });
      readonly(path, (db) => {
        expect(schema(db)).toEqual(want);
      });
    },
  );

  it.each(versions.filter((v) => v >= 3))(
    'keeps the ledger id counter past deleted rows when upgrading from schema %i',
    (version) => {
      const path = join(dir, 'old.db');
      seededAt(path, version);
      const store = openStore(path);
      try {
        const id = store.ledger.insert({
          run_id: 'run_1',
          task: 'triage',
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          in_tok: 1,
          out_tok: 1,
          cache_read: 0,
          cache_write: 0,
          usd: 0,
          priced_by: 'table',
          ts: '2026-01-01T00:00:06.000Z',
        });
        // Seed 3 leaves the counter at 4, seed 12 at 6.
        expect(id).toBe(version >= 12 ? 7 : 5);
      } finally {
        store.close();
      }
    },
  );

  it('reads the rows of the schema before through the store after the upgrade, and writes new ones', () => {
    const path = join(dir, 'old.db');
    seededAt(path, MIGRATIONS.length - 1);
    const store = openStore(path);
    try {
      expect(store.cursors.get('dispatch')).toBe(2);
      expect(store.cursors.get('connector:email')).toBe(41);
      expect(store.events.getById('evt_2')?.payload).toEqual({ label: 'urgent' });
      expect(store.events.rootOf('evt_4')).toBe('evt_4');
      expect(store.state.get('triage', 'seen')?.value).toEqual({ 'mail:1': true });
      expect(store.waits.get('run_2')?.consumed).toEqual(['evt_9']);
      // A wait written before `consumed` existed reads the default.
      expect(store.waits.get('run_4')?.consumed).toEqual([]);
      expect(store.waits.listPending().map((w) => w.run_id)).toEqual(['run_2']);
      expect(store.ledger.sumForRun('run_1')).toBeCloseTo(0.0043);
      expect(store.ledger.listByRun('run_2').map((r) => r.priced_by)).toEqual(['estimate']);
      expect(store.transcripts.listByRun('run_1').map((t) => t.kind)).toEqual([
        'message',
        'tool_call',
      ]);
      expect(store.batches.forRun('run_2')?.batch_id).toBe('msgbatch_1');
      expect(store.pauses.pausedAt('notify')).toBe('2026-01-01T00:00:04.000Z');
      const id = store.ledger.insert({
        run_id: 'run_2',
        task: 'approve',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        in_tok: 1,
        out_tok: 1,
        cache_read: 0,
        cache_write: 0,
        usd: 0,
        priced_by: 'table',
        ts: '2026-01-01T00:00:06.000Z',
      });
      expect(id).toBe(7);
      store.attempts.start('run_2', 1, '2026-01-01T00:00:06.000Z');
      expect(store.attempts.listByRun('run_2').map((a) => a.status)).toEqual(['running']);
    } finally {
      store.close();
    }
  });
});
