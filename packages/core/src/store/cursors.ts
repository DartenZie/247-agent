import type { Database, Statement } from 'better-sqlite3';

export class CursorStore {
  private readonly getStmt: Statement;
  private readonly setStmt: Statement;

  constructor(db: Database) {
    this.getStmt = db.prepare('SELECT seq FROM cursors WHERE name = ?');
    this.setStmt = db.prepare(
      'INSERT INTO cursors (name, seq) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET seq = excluded.seq',
    );
  }

  get(name: string): number {
    const row = this.getStmt.get(name) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  set(name: string, seq: number): void {
    this.setStmt.run(name, seq);
  }
}
