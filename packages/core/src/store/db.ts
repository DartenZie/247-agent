import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import Database from 'better-sqlite3';

import { closeToOthers } from '../private-fs.js';
import { MIGRATIONS, migrate } from './migrations.js';

/**
 * Opens (creating if needed) the state database with WAL and runs pending migrations,
 * refusing a file a newer build has migrated. The file holds every payload, result and
 * transcript, so it is created 0640 whatever the umask, and an existing file, `-wal` or
 * `-shm` the daemon owns loses its bits for other users; SQLite gives the `-wal` and
 * `-shm` it creates the main file's mode.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') {
    if (!existsSync(path)) {
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o640);
    }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      closeToOthers(file);
    }
  }
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    copyBeforeMigration(db, path);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Copies a database with pending migrations to `<path>.schema-<n>.bak`, `n` being its
 * schema version, so a failed migration or a rollback to the release that wrote it has a
 * way back. A new or current database is not copied. The copy is 0640 like the database
 * and is on disk before anything else changes: `VACUUM INTO` does not sync it. Older
 * copies go once it is, since they no longer match the data; only names this function
 * writes are removed. A database that cannot be copied is not migrated.
 */
function copyBeforeMigration(db: Database.Database, path: string): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (path === ':memory:' || current === 0 || current >= MIGRATIONS.length) {
    return;
  }
  const copy = `${path}.schema-${String(current)}.bak`;
  let created = false;
  try {
    rmSync(copy, { force: true });
    closeSync(openSync(copy, 'wx', 0o600));
    created = true;
    chmodSync(copy, 0o640);
    db.prepare('VACUUM INTO ?').run(copy);
    syncFile(copy, 'r+');
  } catch (err) {
    if (created) {
      rmSync(copy, { force: true });
    }
    throw new Error(
      `cannot copy ${path} to ${copy} before migrating it: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  try {
    syncFile(dirname(path), 'r');
  } catch {
    // Not every platform syncs a directory; the copy's own data is already on disk.
  }
  const ours = new RegExp(`^${escapeRegExp(basename(path))}\\.schema-\\d+\\.bak$`);
  for (const name of readdirSync(dirname(path))) {
    if (ours.test(name) && name !== basename(copy)) {
      try {
        unlinkSync(join(dirname(path), name));
      } catch {
        // A copy left behind costs disk, not correctness.
      }
    }
  }
}

function syncFile(path: string, flags: 'r' | 'r+'): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
