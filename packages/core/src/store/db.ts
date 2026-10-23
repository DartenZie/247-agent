import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';

import Database from 'better-sqlite3';

import { closeToOthers } from '../private-fs.js';
import { migrate } from './migrations.js';

/**
 * Opens (creating if needed) the state database with WAL and runs pending migrations. The
 * file holds every payload, result and transcript, so it is created 0640 whatever the
 * umask, and an existing file, `-wal` or `-shm` the daemon owns loses its bits for other
 * users; SQLite gives the `-wal` and `-shm` it creates the main file's mode.
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
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
