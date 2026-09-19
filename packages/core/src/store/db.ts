import Database from 'better-sqlite3';

import { migrate } from './migrations.js';

/** Opens (creating if needed) the state database with WAL and runs pending migrations. */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
