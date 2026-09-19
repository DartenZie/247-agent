import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { DURATION } from './duration.js';
import { issuesFromZod, type ConfigIssue } from './load.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/**
 * `agent.yaml` (ARCHITECTURE §7). Relative paths are resolved against the file's own
 * directory. `secrets`, `budgets`, `retention` and `defaults.llm|agent|retry` are accepted
 * so a full config validates, but nothing reads them yet.
 */
export const AgentFile = z.strictObject({
  db: z.string().min(1).default('/var/lib/online-agent/state.db'),
  socket: z.string().min(1).default('/run/online-agent/core.sock'),
  /** The tasks file. `tasks.d/` is not merged yet. */
  tasks: z.string().min(1).default('tasks.yaml'),
  workers: z.number().int().positive().default(4),
  log: z.strictObject({ level: z.enum(LOG_LEVELS).default('info') }).prefault({}),
  limits: z.strictObject({ max_event_depth: z.number().int().positive().default(32) }).prefault({}),
  defaults: z
    .strictObject({
      timeout: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').default('15m'),
      llm: z.unknown().optional(),
      agent: z.unknown().optional(),
      retry: z.unknown().optional(),
    })
    .prefault({}),
  secrets: z.unknown().optional(),
  budgets: z.unknown().optional(),
  retention: z.unknown().optional(),
});

export type AgentFileConfig = z.infer<typeof AgentFile>;

/** A parsed `agent.yaml` with every path made absolute. */
export interface AgentConfig extends AgentFileConfig {
  /** Absolute path of the file itself. */
  file: string;
}

export type AgentLoadResult =
  | { ok: true; file: string; config: AgentConfig }
  | { ok: false; file: string; issues: ConfigIssue[] };

/** Parses and validates the YAML text of an agent file. Never throws. */
export function parseAgent(text: string, file: string): AgentLoadResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, file, issues: [{ path: '', message: `YAML syntax error: ${message}` }] };
  }
  const result = AgentFile.safeParse(doc ?? {});
  if (!result.success) {
    return { ok: false, file, issues: issuesFromZod(result.error) };
  }
  const absolute = resolve(file);
  const base = dirname(absolute);
  const c = result.data;
  return {
    ok: true,
    file,
    config: {
      ...c,
      file: absolute,
      db: resolve(base, c.db),
      socket: resolve(base, c.socket),
      tasks: resolve(base, c.tasks),
    },
  };
}

/** Reads and validates an agent file. Never throws; a missing file is an issue. */
export function loadAgentFile(path: string): AgentLoadResult {
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
  return parseAgent(text, path);
}
