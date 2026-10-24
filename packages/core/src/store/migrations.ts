import type { Database } from 'better-sqlite3';

/**
 * Ordered, append-only. `PRAGMA user_version` records how many have been applied.
 * Never edit an entry that has shipped; add a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT    NOT NULL UNIQUE,
    type           TEXT    NOT NULL,
    source         TEXT    NOT NULL,
    ts             TEXT    NOT NULL,
    correlation_id TEXT    NOT NULL,
    parent_id      TEXT,
    dedup_key      TEXT    UNIQUE,
    depth          INTEGER NOT NULL DEFAULT 0,
    payload        TEXT    NOT NULL
  );
  CREATE INDEX events_type_seq ON events(type, seq);
  CREATE INDEX events_correlation ON events(correlation_id, seq);

  CREATE TABLE runs (
    id             TEXT PRIMARY KEY,
    task           TEXT NOT NULL,
    event_id       TEXT NOT NULL REFERENCES events(id),
    correlation_id TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
    attempt        INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    started_at     TEXT,
    finished_at    TEXT,
    result         TEXT,
    error          TEXT,
    UNIQUE (task, event_id)
  );
  CREATE INDEX runs_task_status ON runs(task, status);
  CREATE INDEX runs_status_created ON runs(status, created_at);

  CREATE TABLE cursors (
    name TEXT PRIMARY KEY,
    seq  INTEGER NOT NULL
  );
  INSERT INTO cursors (name, seq) VALUES ('dispatch', 0);
  `,
  `
  CREATE TABLE state (
    namespace  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  );

  CREATE TABLE waits (
    run_id     TEXT PRIMARY KEY REFERENCES runs(id),
    task       TEXT NOT NULL,
    type       TEXT NOT NULL,
    filter     TEXT,
    expires_at TEXT,
    on_timeout TEXT NOT NULL CHECK (on_timeout IN ('fail','succeed')),
    resume     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    outcome    TEXT,
    event_id   TEXT
  );
  CREATE INDEX waits_type ON waits(type);
  CREATE INDEX waits_expires ON waits(expires_at);
  `,
  `
  CREATE TABLE ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT    NOT NULL REFERENCES runs(id),
    task        TEXT    NOT NULL,
    provider    TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    in_tok      INTEGER NOT NULL,
    out_tok     INTEGER NOT NULL,
    cache_read  INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    usd         REAL    NOT NULL,
    priced_by   TEXT    NOT NULL CHECK (priced_by IN ('table','provider','unpriced')),
    ts          TEXT    NOT NULL
  );
  CREATE INDEX ledger_ts ON ledger(ts);
  CREATE INDEX ledger_run ON ledger(run_id);
  CREATE INDEX ledger_task_ts ON ledger(task, ts);
  `,
  `
  -- Retention: an event goes only when no run or wait points at it; without these each
  -- candidate event would scan the whole runs table.
  CREATE INDEX runs_event ON runs(event_id);
  CREATE INDEX waits_event ON waits(event_id);
  `,
  `
  CREATE TABLE transcripts (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT    NOT NULL REFERENCES runs(id),
    ts     TEXT    NOT NULL,
    turn   INTEGER NOT NULL,
    kind   TEXT    NOT NULL,
    text   TEXT,
    data   TEXT
  );
  CREATE INDEX transcripts_run ON transcripts(run_id, id);
  `,
  `
  -- In-flight Message Batches requests of \`llm\` actions with \`batch: true\`; a row is
  -- deleted when the batch's result is ledgered and published.
  CREATE TABLE llm_batches (
    batch_id     TEXT    PRIMARY KEY,
    run_id       TEXT    NOT NULL,
    task         TEXT    NOT NULL,
    attempt      INTEGER NOT NULL,
    provider     TEXT    NOT NULL,
    model        TEXT    NOT NULL,
    structured   INTEGER NOT NULL,
    worst_usd    REAL    NOT NULL,
    submitted_at TEXT    NOT NULL
  );
  CREATE INDEX llm_batches_run ON llm_batches(run_id);
  `,
  `
  -- Ids (a JSON array) of the events that ended the run's earlier waits; the backlog check
  -- at arming skips them, so one event never ends two waits of a run.
  ALTER TABLE waits ADD COLUMN consumed TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- How far the run's action got (a sequence's next step and earlier results), so a retry
  -- or a recovery does not repeat a finished step; cleared when the run finishes.
  ALTER TABLE runs ADD COLUMN progress TEXT;
  `,
  `
  -- The task definition the run's first attempt started with; later attempts and resumes
  -- run under it, so a reload never changes a run in flight. Cleared when the run finishes.
  ALTER TABLE runs ADD COLUMN config TEXT;
  `,
  `
  -- Tasks paused with \`oa tasks pause\`: the dispatcher starts no new run of a task listed
  -- here. Keyed by name, so a pause outlives a reload and a restart.
  CREATE TABLE task_pauses (
    task      TEXT PRIMARY KEY,
    paused_at TEXT NOT NULL
  );
  `,
  `
  -- The causal chain's root event (its own id for a root; NULL on rows older than this
  -- migration): the dispatcher caps the runs one chain starts, \`each\` fan-out included.
  ALTER TABLE events ADD COLUMN root_id TEXT;
  CREATE INDEX events_root ON events(root_id);
  `,
];

/**
 * Applies the pending migrations in one transaction, so a failure leaves the file at the
 * version the copy taken before it holds (`db.ts`). A database a newer build has migrated
 * is refused before anything is written: this build cannot know what those migrations
 * changed.
 */
export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${String(current)} is newer than this build's ` +
        `${String(MIGRATIONS.length)}: run the release that migrated it, or restore the ` +
        `${db.name}.schema-<n>.bak copy taken before it`,
    );
  }
  db.transaction(() => {
    for (const sql of MIGRATIONS.slice(current)) {
      db.exec(sql);
    }
    db.pragma(`user_version = ${String(MIGRATIONS.length)}`);
  })();
}
