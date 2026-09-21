import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { PricingError, resolvePricing } from '../llm/pricing.js';
import { parseAgent } from './agent.js';
import { loadManifestFile, looksLikeManifest } from './connector.js';
import { checkLlmTasks } from './crosscheck.js';
import { loadConnectors, loadTasks, parseTasks, type ConfigIssue } from './load.js';

export type FileKind = 'tasks' | 'agent' | 'connector' | 'unknown';

/** One validated file, as `oa validate` reports it. */
export type FileCheck =
  | { ok: true; file: string; kind: FileKind; summary: string }
  | { ok: false; file: string; kind: FileKind; issues: ConfigIssue[] };

/**
 * Validates one config file of any kind. A document whose top-level `tasks` is a list is a
 * tasks file; one with `name` and `exec` is a connector manifest; anything else is an
 * `agent.yaml` (where `tasks` is a path), whose tasks files and connector manifests are
 * checked too, so `oa validate agent.yaml` covers the whole config.
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
  if (
    doc !== null &&
    typeof doc === 'object' &&
    'tasks' in doc &&
    Array.isArray(doc.tasks) &&
    doc.tasks.every((t: unknown) => typeof t !== 'string') // agent.yaml lists paths there
  ) {
    const r = parseTasks(text, path);
    return [
      r.ok
        ? { ok: true, file: path, kind: 'tasks', summary: `${String(r.config.tasks.length)} tasks` }
        : fail(path, 'tasks', r.issues),
    ];
  }
  if (looksLikeManifest(doc)) {
    const r = loadManifestFile(path);
    return [
      r.ok
        ? { ok: true, file: path, kind: 'connector', summary: `connector ${r.config.name}` }
        : fail(path, 'connector', r.issues),
    ];
  }
  const r = parseAgent(text, path);
  if (!r.ok) {
    return [fail(path, 'agent', r.issues)];
  }
  let pricing;
  try {
    pricing = resolvePricing(r.config.pricing);
  } catch (err) {
    if (err instanceof PricingError) {
      return [fail(path, 'agent', [{ path: `pricing.${err.model}`, message: err.message }])];
    }
    throw err;
  }
  const out: FileCheck[] = [
    {
      ok: true,
      file: path,
      kind: 'agent',
      summary: `tasks ${r.config.tasks.join(', ')}${
        r.config.connectorPaths.length === 0
          ? ''
          : `; connectors ${r.config.connectorPaths.join(', ')}`
      }`,
    },
  ];
  const tasks = loadTasks(r.config.tasks);
  for (const f of tasks.files) {
    if (!f.ok) {
      out.push(fail(f.file, 'tasks', f.issues));
      continue;
    }
    // What the tasks file cannot know on its own: providers, prices and prompt files.
    const issues = checkLlmTasks(f.config.tasks, {
      providers: r.config.providers,
      pricing,
      defaults: r.config.defaults.llm,
      decideDefaults: r.config.defaults.decide,
      configDir: dirname(r.config.file),
    });
    out.push(
      issues.length === 0
        ? {
            ok: true,
            file: f.file,
            kind: 'tasks',
            summary: `${String(f.config.tasks.length)} tasks`,
          }
        : fail(f.file, 'tasks', issues),
    );
  }
  const connectors = loadConnectors(r.config.connectorPaths, r.config.connectors);
  for (const f of connectors.files) {
    if (f.file === r.config.file) {
      continue; // inline manifests were validated with agent.yaml itself
    }
    out.push(
      f.ok
        ? { ok: true, file: f.file, kind: 'connector', summary: `connector ${f.name ?? ''}` }
        : fail(f.file, 'connector', f.issues ?? []),
    );
  }
  return out;
}

function fail(file: string, kind: FileKind, issues: ConfigIssue[]): FileCheck {
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
