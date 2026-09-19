import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';
import type { ZodError } from 'zod';

import { TasksFile, type TasksFileConfig } from './schema.js';

export interface ConfigIssue {
  /** Dotted/indexed path like `tasks[1].trigger.filter`; empty for file-level problems. */
  path: string;
  message: string;
}

export type LoadResult =
  | { ok: true; file: string; config: TasksFileConfig }
  | { ok: false; file: string; issues: ConfigIssue[] };

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const p of path) {
    if (typeof p === 'number') {
      out += `[${String(p)}]`;
    } else {
      out += out === '' ? String(p) : `.${String(p)}`;
    }
  }
  return out;
}

export function issuesFromZod(err: ZodError): ConfigIssue[] {
  return err.issues.map((i) => ({ path: formatPath(i.path), message: i.message }));
}

/** Parses and validates the YAML text of a tasks file. Never throws. */
export function parseTasks(text: string, file: string): LoadResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, file, issues: [{ path: '', message: `YAML syntax error: ${message}` }] };
  }
  const result = TasksFile.safeParse(doc);
  if (!result.success) {
    return { ok: false, file, issues: issuesFromZod(result.error) };
  }
  return { ok: true, file, config: result.data };
}

/** Reads and validates a tasks file. Never throws; a missing file is an issue. */
export function loadTasksFile(path: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      file: path,
      issues: [{ path: '', message: `cannot read file: ${message}` }],
    };
  }
  return parseTasks(text, path);
}
