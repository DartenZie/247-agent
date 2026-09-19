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
];

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  MIGRATIONS.forEach((sql, v) => {
    if (v < current) {
      return;
    }
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${String(v + 1)}`);
    })();
  });
}
