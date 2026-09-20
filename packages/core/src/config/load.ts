import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import type { ZodError } from 'zod';

import { loadManifestFile, type ConnectorConfig } from './connector.js';
import { TasksFile, type TaskConfig, type TasksFileConfig } from './schema.js';

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

const YAML_FILE = /\.ya?ml$/;

/**
 * Expands each path to itself (a file) or to its `*.yaml` files in name order (a
 * directory such as `tasks.d`). A missing path is returned as is so the loader reports it.
 */
export function expandConfigPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      // reported by the loader as unreadable
    }
    if (!isDir) {
      out.push(p);
      continue;
    }
    for (const name of readdirSync(p).sort()) {
      if (YAML_FILE.test(name)) {
        out.push(join(p, name));
      }
    }
  }
  return out;
}

/** Every file's result plus, when all pass, the merged config. */
export interface TasksLoadResult {
  ok: boolean;
  files: LoadResult[];
  /** Merged tasks of every file, in file order; only when `ok`. */
  config?: TasksFileConfig;
}

/**
 * Loads and merges tasks files and `tasks.d` directories (ARCHITECTURE §4, §7). A task
 * name defined in two files is an issue on the second file. At least one task is required.
 */
export function loadTasks(paths: readonly string[]): TasksLoadResult {
  const files = expandConfigPaths(paths).map(loadTasksFile);
  if (files.length === 0) {
    return {
      ok: false,
      files: [
        {
          ok: false,
          file: paths[0] ?? '',
          issues: [{ path: '', message: 'no tasks files found' }],
        },
      ],
    };
  }
  const seen = new Map<string, string>();
  const tasks: TaskConfig[] = [];
  let ok = true;
  const results: LoadResult[] = [];
  for (const r of files) {
    if (!r.ok) {
      ok = false;
      results.push(r);
      continue;
    }
    const issues: ConfigIssue[] = [];
    r.config.tasks.forEach((t, i) => {
      const first = seen.get(t.name);
      if (first !== undefined) {
        issues.push({
          path: `tasks[${String(i)}].name`,
          message: `duplicate task name "${t.name}" (also defined in ${first})`,
        });
      } else {
        seen.set(t.name, r.file);
        tasks.push(t);
      }
    });
    if (issues.length > 0) {
      ok = false;
      results.push({ ok: false, file: r.file, issues });
    } else {
      results.push(r);
    }
  }
  return ok ? { ok, files: results, config: { tasks } } : { ok, files: results };
}

export interface ConnectorsLoadResult {
  ok: boolean;
  files: { ok: boolean; file: string; name?: string; issues?: ConfigIssue[] }[];
  /** All manifests, inline ones first; only when `ok`. */
  connectors?: ConnectorConfig[];
}

/**
 * Loads manifest files/directories and merges them with inline manifests. Names must be
 * unique, and a `poller` must name a process connector that serves its op.
 */
export function loadConnectors(
  paths: readonly string[],
  inline: readonly ConnectorConfig[] = [],
): ConnectorsLoadResult {
  const seen = new Map<string, string>();
  const all: { config: ConnectorConfig; file: string }[] = [];
  /** Every file in load order, with the issues found in it so far. */
  const entries: { file: string; name?: string; issues: ConfigIssue[] }[] = [];
  const entry = (file: string): { file: string; name?: string; issues: ConfigIssue[] } => {
    let e = entries.find((x) => x.file === file);
    if (e === undefined) {
      e = { file, issues: [] };
      entries.push(e);
    }
    return e;
  };
  const add = (c: ConnectorConfig, file: string): void => {
    const first = seen.get(c.name);
    if (first !== undefined) {
      entry(file).issues.push({
        path: 'name',
        message: `duplicate connector name "${c.name}" (also defined in ${first})`,
      });
      return;
    }
    seen.set(c.name, file);
    all.push({ config: c, file });
    entry(file).name = c.name;
  };
  for (const c of inline) {
    add(c, c.file);
  }
  for (const file of expandConfigPaths(paths)) {
    const r = loadManifestFile(file);
    if (r.ok) {
      add(r.config, file);
    } else {
      entry(file).issues.push(...r.issues);
    }
  }
  for (const { config, file } of all) {
    const issue = checkPollerTarget(config, all);
    if (issue !== null) {
      entry(file).issues.push(issue);
    }
  }
  const files: ConnectorsLoadResult['files'] = entries.map((e) =>
    e.issues.length === 0
      ? { ok: true, file: e.file, ...(e.name === undefined ? {} : { name: e.name }) }
      : { ok: false, file: e.file, issues: e.issues },
  );
  const ok = files.every((f) => f.ok);
  return ok ? { ok, files, connectors: all.map((c) => c.config) } : { ok, files };
}

/** A poller's `config.connector`/`op` must resolve to a process connector that serves the op. */
function checkPollerTarget(
  c: ConnectorConfig,
  all: readonly { config: ConnectorConfig }[],
): ConfigIssue | null {
  if (c.builtin !== 'poller') {
    return null;
  }
  const { connector, op } = c.config as { connector: string; op: string };
  const target = all.find((x) => x.config.name === connector)?.config;
  if (target === undefined) {
    return { path: 'config.connector', message: `unknown connector "${connector}"` };
  }
  if (target.builtin !== undefined || target.transport === 'none') {
    return { path: 'config.connector', message: `connector "${connector}" serves no ops` };
  }
  if (target.ops.length > 0 && !target.ops.includes(op)) {
    return {
      path: 'config.op',
      message: `op "${op}" is not in the ops of connector "${connector}"`,
    };
  }
  return null;
}
