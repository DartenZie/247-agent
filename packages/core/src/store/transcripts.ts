import type { Database, Statement } from 'better-sqlite3';

import type { JsonValue } from './types.js';

/**
 * What one transcript row records (docs/internal/agent-action.md). The kinds follow the ACP session:
 * the prompt the core sent, what the agent said and thought, each tool call and its
 * later status, every permission decision, the reported usage, how the turn stopped,
 * why the core cancelled it, and the RESULT.json it read.
 */
export const TRANSCRIPT_KINDS = [
  'prompt',
  'text',
  'thought',
  'tool_call',
  'tool_call_update',
  'permission',
  'usage',
  'stop',
  'cancel',
  'result',
] as const;
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

export interface TranscriptEntry {
  id: number;
  run_id: string;
  ts: string;
  /** 1 for the first prompt of the run, 2 for the nudge. */
  turn: number;
  kind: TranscriptKind;
  /** The prompt, a message or a thought; null for structured kinds. */
  text: string | null;
  /** The kind's details (tool call id, kind, command, locations, status, decision, …). */
  data: JsonValue | null;
}

export type NewTranscriptEntry = Omit<TranscriptEntry, 'id'>;

/** Everything a transcript sink needs; `ActionContext.transcripts` is one. */
export interface TranscriptSink {
  append(entry: NewTranscriptEntry): number;
}

export interface TranscriptFilter {
  /** Entries with `id > after`, for following a running agent. */
  after?: number | undefined;
  /** Capped at 5000; default 1000. */
  limit?: number | undefined;
}

interface TranscriptRow extends Omit<TranscriptEntry, 'data'> {
  data: string | null;
}

function rowToEntry(row: unknown): TranscriptEntry {
  const r = row as TranscriptRow;
  return { ...r, data: r.data === null ? null : (JSON.parse(r.data) as JsonValue) };
}

/** Agent transcripts: one row per session update, in order, per run. */
export class TranscriptStore implements TranscriptSink {
  private readonly insertStmt: Statement;
  private readonly listStmt: Statement;
  private readonly countStmt: Statement;
  private readonly deleteForRunStmt: Statement;

  constructor(db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO transcripts (run_id, ts, turn, kind, text, data)
       VALUES (@run_id, @ts, @turn, @kind, @text, @data)`,
    );
    this.listStmt = db.prepare(
      'SELECT * FROM transcripts WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?',
    );
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE run_id = ?');
    this.deleteForRunStmt = db.prepare('DELETE FROM transcripts WHERE run_id = ?');
  }

  /** Returns the new row id. */
  append(entry: NewTranscriptEntry): number {
    return Number(
      this.insertStmt.run({
        ...entry,
        data: entry.data === null ? null : JSON.stringify(entry.data),
      }).lastInsertRowid,
    );
  }

  listByRun(runId: string, filter: TranscriptFilter = {}): TranscriptEntry[] {
    const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 5000);
    return this.listStmt.all(runId, filter.after ?? 0, limit).map(rowToEntry);
  }

  countByRun(runId: string): number {
    return (this.countStmt.get(runId) as { n: number }).n;
  }

  /** Retention: the rows of runs about to be deleted. Returns how many went. */
  deleteForRuns(runIds: readonly string[]): number {
    let n = 0;
    for (const id of runIds) {
      n += this.deleteForRunStmt.run(id).changes;
    }
    return n;
  }
}
