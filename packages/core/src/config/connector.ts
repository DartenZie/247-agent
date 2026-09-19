import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { collectTemplateRefs } from '../expr/template.js';
import { DURATION } from './duration.js';
import { issuesFromZod, type ConfigIssue } from './load.js';
import { validateEventType } from './validators.js';

const NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * A connector manifest (ARCHITECTURE §6): `connectors.d/<name>.yaml` or an entry of the
 * `connectors:` list in agent.yaml. `config` and `env` values take `${secrets.<name>}`;
 * they are rendered at spawn time and reach the child only through its environment.
 */
export const ConnectorManifest = z
  .strictObject({
    name: z.string().regex(NAME, 'connector names are [a-z][a-z0-9_-]*'),
    /** argv of the connector process. */
    exec: z.array(z.string().min(1)).min(1),
    /** Working directory; relative to the manifest file. */
    cwd: z.string().min(1).optional(),
    /** `stdio`: the process is an MCP server on stdin/stdout. `none`: it only emits events. */
    transport: z.enum(['stdio', 'none']).default('stdio'),
    /** Event types the connector emits (documentation; checked for shape). */
    emits: z.array(z.string().min(1)).default([]),
    /** MCP tools the core may call; empty = whatever the server lists. */
    ops: z.array(z.string().min(1)).default([]),
    /** Passed as `OA_CONFIG_JSON`. */
    config: z.record(z.string(), z.unknown()).default({}),
    /** Extra environment for the process. */
    env: z.record(z.string(), z.string()).default({}),
    restart: z
      .strictObject({
        /** First delay after a crash; doubles up to `max`. */
        base: z.string().regex(DURATION, 'durations look like 1s, 30s').default('1s'),
        max: z.string().regex(DURATION, 'durations look like 1s, 30s').default('60s'),
      })
      .prefault({}),
    health: z.strictObject({ interval: z.string().regex(DURATION).optional() }).optional(),
  })
  .superRefine((m, ctx) => {
    m.emits.forEach((t, i) => {
      const err = validateEventType(t);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: ['emits', i], message: err });
      }
    });
    const refs = collectTemplateRefs({ config: m.config, env: m.env });
    for (const e of refs.errors) {
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: `${e.message} (in "${e.template}")`,
      });
    }
    for (const root of refs.roots) {
      if (root !== 'secrets' && root !== 'env') {
        ctx.addIssue({
          code: 'custom',
          path: ['config'],
          message: `only \${secrets.<name>} and \${env.<VAR>} can be used in a manifest (found "${root}")`,
        });
      }
    }
    for (const t of refs.wholeSecrets) {
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: `reference secrets by name (secrets.<name>), not as a whole (in "${t}")`,
      });
    }
    if (m.transport === 'none' && m.ops.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ops'],
        message: 'a connector with transport "none" cannot serve ops',
      });
    }
  });

export type ConnectorManifestConfig = z.infer<typeof ConnectorManifest>;

/** A manifest with `cwd` made absolute and its origin recorded. */
export interface ConnectorConfig extends ConnectorManifestConfig {
  /** The manifest file, or the agent.yaml it was inlined in. */
  file: string;
}

export type ConnectorLoadResult =
  | { ok: true; file: string; config: ConnectorConfig }
  | { ok: false; file: string; issues: ConfigIssue[] };

/** True for a YAML document that looks like a manifest (`oa validate` uses it to tell files apart). */
export function looksLikeManifest(doc: unknown): boolean {
  return doc !== null && typeof doc === 'object' && 'exec' in doc && 'name' in doc;
}

export function parseManifest(doc: unknown, file: string): ConnectorLoadResult {
  const result = ConnectorManifest.safeParse(doc);
  if (!result.success) {
    return { ok: false, file, issues: issuesFromZod(result.error) };
  }
  const c = result.data;
  const base = dirname(resolve(file));
  return {
    ok: true,
    file,
    config: { ...c, ...(c.cwd === undefined ? {} : { cwd: resolve(base, c.cwd) }), file },
  };
}

/** Reads and validates one manifest file. Never throws. */
export function loadManifestFile(path: string): ConnectorLoadResult {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      file: path,
      issues: [{ path: '', message: `cannot read manifest: ${message}` }],
    };
  }
  return parseManifest(doc, path);
}
