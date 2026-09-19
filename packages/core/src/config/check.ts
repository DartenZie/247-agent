import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { parseAgent } from './agent.js';
import { loadTasksFile, parseTasks, type ConfigIssue } from './load.js';

/** One validated file, as `oa validate` reports it. */
export type FileCheck =
  | { ok: true; file: string; kind: 'tasks' | 'agent'; summary: string }
  | { ok: false; file: string; kind: 'tasks' | 'agent' | 'unknown'; issues: ConfigIssue[] };

/**
 * Validates one config file of either kind. A document whose top-level `tasks` is a list is
 * a tasks file; anything else is an `agent.yaml` (where `tasks` is a path), whose referenced tasks file is checked too,
 * so `oa validate agent.yaml` covers the whole config.
 */
export function checkConfigFile(path: string): FileCheck[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [fail(path, 'unknown', [{ path: '', message: `cannot read file: ${message}` }])];
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [fail(path, 'unknown', [{ path: '', message: `YAML syntax error: ${message}` }])];
  }
  if (doc !== null && typeof doc === 'object' && 'tasks' in doc && Array.isArray(doc.tasks)) {
    const r = parseTasks(text, path);
    return [
      r.ok
        ? { ok: true, file: path, kind: 'tasks', summary: `${String(r.config.tasks.length)} tasks` }
        : fail(path, 'tasks', r.issues),
    ];
  }
  const r = parseAgent(text, path);
  if (!r.ok) {
    return [fail(path, 'agent', r.issues)];
  }
  const tasks = loadTasksFile(r.config.tasks);
  return [
    { ok: true, file: path, kind: 'agent', summary: `tasks ${r.config.tasks}` },
    tasks.ok
      ? {
          ok: true,
          file: tasks.file,
          kind: 'tasks',
          summary: `${String(tasks.config.tasks.length)} tasks`,
        }
      : fail(tasks.file, 'tasks', tasks.issues),
  ];
}

function fail(file: string, kind: FileCheck['kind'], issues: ConfigIssue[]): FileCheck {
  return { ok: false, file, kind, issues };
}

/** One line per issue: `<file>: <path>: <message>`, or a single `ok` line. */
export function formatCheck(check: FileCheck): string[] {
  if (check.ok) {
    return [`ok ${check.file} (${check.summary})`];
  }
  return check.issues.map((i) =>
    i.path === '' ? `${check.file}: ${i.message}` : `${check.file}: ${i.path}: ${i.message}`,
  );
}
