import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { SecretsConfig } from '../secrets/secrets.js';
import { ConnectorManifest, parseManifest, type ConnectorConfig } from './connector.js';
import { DURATION } from './duration.js';
import { issuesFromZod, type ConfigIssue } from './load.js';
import { Retry } from './schema.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const pathList = z.union([z.string().min(1), z.array(z.string().min(1))]);

/**
 * `agent.yaml` (ARCHITECTURE §7). Relative paths are resolved against the file's own
 * directory. `budgets`, `retention` and `defaults.llm|agent` are accepted so a full config
 * validates, but nothing reads them until the `llm`/`agent` runners exist.
 */
export const AgentFile = z.strictObject({
  db: z.string().min(1).default('/var/lib/247-agent/state.db'),
  socket: z.string().min(1).default('/run/247-agent/core.sock'),
  /** Tasks files and/or directories of `*.yaml` (`tasks.d`), merged; task names must be unique across them. */
  tasks: pathList.default('tasks.yaml'),
  /** Manifest files, directories of manifests (`connectors.d`), or inline manifests. */
  connectors: z
    .union([z.string().min(1), z.array(z.union([z.string().min(1), ConnectorManifest]))])
    .default([]),
  workers: z.number().int().positive().default(4),
  log: z.strictObject({ level: z.enum(LOG_LEVELS).default('info') }).prefault({}),
  limits: z.strictObject({ max_event_depth: z.number().int().positive().default(32) }).prefault({}),
  defaults: z
    .strictObject({
      timeout: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').default('15m'),
      retry: Retry.prefault({}),
      llm: z.unknown().optional(),
      agent: z.unknown().optional(),
    })
    .prefault({}),
  secrets: SecretsConfig.prefault({ backend: 'env' }),
  budgets: z.unknown().optional(),
  retention: z.unknown().optional(),
});

export type AgentFileConfig = z.infer<typeof AgentFile>;

/** A parsed `agent.yaml` with every path made absolute and inline manifests parsed. */
export interface AgentConfig extends Omit<AgentFileConfig, 'tasks' | 'connectors'> {
  /** Absolute path of the file itself. */
  file: string;
  /** Absolute tasks files/directories. */
  tasks: string[];
  /** Absolute manifest files/directories. */
  connectorPaths: string[];
  /** Manifests written inline in agent.yaml. */
  connectors: ConnectorConfig[];
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
  const tasks = (typeof c.tasks === 'string' ? [c.tasks] : c.tasks).map((p) => resolve(base, p));
  const connectorPaths: string[] = [];
  const connectors: ConnectorConfig[] = [];
  const issues: ConfigIssue[] = [];
  const entries = typeof c.connectors === 'string' ? [c.connectors] : c.connectors;
  entries.forEach((entry, i) => {
    if (typeof entry === 'string') {
      connectorPaths.push(resolve(base, entry));
      return;
    }
    const parsed = parseManifest(entry, absolute);
    if (parsed.ok) {
      connectors.push(parsed.config);
    } else {
      issues.push(
        ...parsed.issues.map((x) => ({ ...x, path: `connectors[${String(i)}].${x.path}` })),
      );
    }
  });
  if (issues.length > 0) {
    return { ok: false, file, issues };
  }
  return {
    ok: true,
    file,
    config: {
      ...c,
      file: absolute,
      db: resolve(base, c.db),
      socket: resolve(base, c.socket),
      tasks,
      connectorPaths,
      connectors,
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
