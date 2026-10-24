import type { Database, Statement } from 'better-sqlite3';

export interface PauseRecord {
  task: string;
  paused_at: string;
}

/** Paused tasks (`oa tasks pause`): the dispatcher starts no new run of one. */
export class PauseStore {
  private readonly insertStmt: Statement;
  private readonly deleteStmt: Statement;
  private readonly getStmt: Statement;
  private readonly listStmt: Statement;

  constructor(db: Database) {
    this.insertStmt = db.prepare(
      'INSERT OR IGNORE INTO task_pauses (task, paused_at) VALUES (?, ?)',
    );
    this.deleteStmt = db.prepare('DELETE FROM task_pauses WHERE task = ?');
    this.getStmt = db.prepare('SELECT paused_at FROM task_pauses WHERE task = ?');
    this.listStmt = db.prepare('SELECT task, paused_at FROM task_pauses ORDER BY task');
  }

  /** Returns false when the task was already paused; its `paused_at` is kept. */
  pause(task: string, at: string): boolean {
    return this.insertStmt.run(task, at).changes === 1;
  }

  /** Returns false when the task was not paused. */
  resume(task: string): boolean {
    return this.deleteStmt.run(task).changes === 1;
  }

  /** When the task was paused; `undefined` when it is not. */
  pausedAt(task: string): string | undefined {
    const row = this.getStmt.get(task) as { paused_at: string } | undefined;
    return row?.paused_at;
  }

  list(): PauseRecord[] {
    return this.listStmt.all() as PauseRecord[];
  }
}
