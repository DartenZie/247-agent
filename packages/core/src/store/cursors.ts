import type { Database, Statement } from 'better-sqlite3';

export class CursorStore {
  private readonly getStmt: Statement;
  private readonly setStmt: Statement;
  private readonly namesStmt: Statement;
  private readonly deleteStmt: Statement;

  constructor(db: Database) {
    this.getStmt = db.prepare('SELECT seq FROM cursors WHERE name = ?');
    this.setStmt = db.prepare(
      'INSERT INTO cursors (name, seq) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET seq = excluded.seq',
    );
    this.namesStmt = db.prepare('SELECT name FROM cursors WHERE substr(name, 1, ?) = ?');
    this.deleteStmt = db.prepare('DELETE FROM cursors WHERE name = ?');
  }

  /** Names that start with `prefix`. */
  names(prefix: string): string[] {
    return (this.namesStmt.all(prefix.length, prefix) as { name: string }[]).map((r) => r.name);
  }

  delete(name: string): void {
    this.deleteStmt.run(name);
  }

  get(name: string): number {
    const row = this.getStmt.get(name) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  set(name: string, seq: number): void {
    this.setStmt.run(name, seq);
  }
}
