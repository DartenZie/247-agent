import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { AgentSandbox } from '../actions/sandbox.js';
import { PollerConfig } from '../connectors/poller.js';
import { collectTemplateRefs } from '../expr/template.js';
import { DURATION } from './duration.js';
import { issuesFromZod, type ConfigIssue } from './load.js';
import { validateEventType } from './validators.js';

const NAME = /^[a-z][a-z0-9_-]*$/;

/** Connectors that run inside the core, configured by a manifest with `builtin` instead of `exec`. */
export const BUILTINS = ['poller'] as const;

export const TRANSPORTS = ['stdio', 'none', 'acp'] as const;
export type Transport = (typeof TRANSPORTS)[number];

/** Who runs a process connector: the core's supervisor, or its own systemd unit. */
export const MANAGERS = ['core', 'systemd'] as const;
export type Manager = (typeof MANAGERS)[number];

/** Where the units' runtime directories live (`RuntimeDirectory=247-agent-connector/%i`). */
export const UNIT_RUNTIME_ROOT = '/run/247-agent-connector';

const ManifestFields = z.strictObject({
  name: z.string().regex(NAME, 'connector names are [a-z][a-z0-9_-]*'),
  /** argv of the connector process. Exactly one of `exec` and `builtin`. */
  exec: z.array(z.string().min(1)).min(1).optional(),
  /** A connector implemented by the core itself; `config` is that built-in's own. */
  builtin: z.enum(BUILTINS).optional(),
  /** Working directory; relative to the manifest file. */
  cwd: z.string().min(1).optional(),
  /**
   * `stdio`: the process is an MCP server on stdin/stdout. `none`: it only emits events.
   * `acp`: an Agent Client Protocol agent that `agent` actions open sessions on (§5.4).
   * Defaults to `stdio` for a process and `none` for a built-in.
   */
  transport: z.enum(TRANSPORTS).optional(),
  /**
   * `core` (default): the supervisor spawns the process as a child of the daemon.
   * `systemd`: the process runs in its own `247-agent-connector@<name>` unit, as its own
   * user with its own credentials and hardening; the core never spawns it nor resolves its
   * secrets. A `stdio` one serves its ops on `socket`, which the core connects to; a
   * `none` one only emits, and the core just lists it.
   */
  managed_by: z.enum(MANAGERS).default('core'),
  /**
   * `managed_by: systemd` + `stdio` only: the Unix socket the unit serves MCP on.
   * Default `/run/247-agent-connector/<name>/mcp.sock`, inside the unit's runtime directory.
   */
  socket: z.string().min(1).optional(),
  /** Event types the connector emits (documentation; checked for shape). */
  emits: z.array(z.string().min(1)).default([]),
  /** MCP tools the core may call; empty = whatever the server lists. */
  ops: z.array(z.string().min(1)).default([]),
  /** Passed as `OA_CONFIG_JSON`; for a built-in, its own config. */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Extra environment for the process. */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * `acp` only: run the agent program in bubblewrap (§5.4, §11): the OS and the install
   * read-only, `defaults.agent.work_dir` the only writable path (every run's workspace
   * and the agent's own home, `<work_dir>/home/<name>`), the daemon's config, database
   * and socket out of reach, other processes invisible. Repositories that `git-worktree`
   * workspaces come from go in `ro_binds`. `network: { allow: [host[:port], …] }` takes the
   * host's network away and lets the program reach only those hosts, through the core's
   * filtering proxy (`[]`: none at all). Default `none`: the program runs as the daemon.
   */
  sandbox: AgentSandbox.optional(),
  restart: z
    .strictObject({
      /** First delay after a crash; doubles up to `max`. */
      base: z.string().regex(DURATION, 'durations look like 1s, 30s').default('1s'),
      max: z.string().regex(DURATION, 'durations look like 1s, 30s').default('60s'),
    })
    .prefault({}),
  /**
   * Liveness checks for a `stdio` connector: every `interval` the core sends an MCP `ping`;
   * `failures` consecutive misses (no answer within `timeout`, or an error) count as a
   * crash: the process is killed and respawned with the usual backoff.
   */
  health: z
    .strictObject({
      interval: z.string().regex(DURATION, 'durations look like 30s, 1m'),
      timeout: z.string().regex(DURATION, 'durations look like 5s, 30s').default('10s'),
      failures: z.number().int().positive().default(3),
    })
    .optional(),
});

type ManifestValues = z.infer<typeof ManifestFields>;

/** Validates a built-in's `config`; issues are reported under `config`. */
const BUILTIN_CHECKS: Record<
  (typeof BUILTINS)[number],
  (m: ManifestValues, ctx: z.RefinementCtx) => void
> = {
  poller: (m, ctx) => {
    const r = PollerConfig.safeParse(m.config);
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({ code: 'custom', path: ['config', ...issue.path], message: issue.message });
      }
    } else if (m.emits.length > 0 && !m.emits.includes(r.data.event)) {
      ctx.addIssue({
        code: 'custom',
        path: ['emits'],
        message: `a poller emits its config.event "${r.data.event}"; list it or leave emits out`,
      });
    }
  },
};

/** The transport a manifest means: `stdio` for a process unless it says otherwise, `none` for a built-in. */
function effectiveTransport(m: {
  transport?: Transport | undefined;
  builtin?: string | undefined;
}): Transport {
  return m.transport ?? (m.builtin === undefined ? 'stdio' : 'none');
}

/**
 * A connector manifest (ARCHITECTURE §6): `connectors.d/<name>.yaml` or an entry of the
 * `connectors:` list in agent.yaml. `config` and `env` values take `${secrets.<name>}`;
 * they are rendered at spawn time and reach the child only through its environment. A
 * manifest with `builtin` instead of `exec` configures a connector the core runs itself
 * (the `poller`); its `config` is validated here so `oa validate` catches mistakes.
 * `parseManifest` fills the transport default and resolves `cwd`.
 */
export const ConnectorManifest = ManifestFields.superRefine((m, ctx) => {
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
  if (m.health !== undefined && effectiveTransport(m) !== 'stdio' && m.builtin === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['health'],
      message: `health checks ping the connector's MCP server; a "${effectiveTransport(m)}" connector has none (its process exit is watched instead)`,
    });
  }
  if (effectiveTransport(m) === 'none' && m.ops.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['ops'],
      message: 'a connector with transport "none" cannot serve ops',
    });
  }
  if (m.transport === 'acp') {
    for (const field of ['ops', 'emits'] as const) {
      if (m[field].length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `an acp connector runs agent sessions; it serves no ops and emits no events ("${field}" must be empty)`,
        });
      }
    }
    if (m.builtin === undefined && Object.keys(m.config).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message:
          'an acp connector gets no OA_CONFIG_JSON: configure the agent program through "env" (its model key and settings)',
      });
    }
    if (m.builtin !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['transport'],
        message: 'a built-in connector cannot be an acp agent',
      });
    }
  }
  if (m.sandbox !== undefined && m.sandbox.backend !== 'none' && m.transport !== 'acp') {
    ctx.addIssue({
      code: 'custom',
      path: ['sandbox'],
      message:
        'only an acp connector (the agent program) can be sandboxed: a connector needs the core socket, which the sandbox hides',
    });
  }
  if (m.managed_by === 'systemd') {
    const refuse = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (m.builtin !== undefined) {
      refuse('managed_by', 'a built-in connector runs inside the core; it has no unit');
    } else if (m.transport === 'acp') {
      refuse(
        'managed_by',
        'an acp agent runs as a child of the core (use sandbox: bwrap to confine it)',
      );
    }
  } else if (m.socket !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['socket'],
      message:
        'socket is where a managed_by: systemd connector serves its ops; this one is spawned by the core',
    });
  }
  if (m.socket !== undefined) {
    if (!isAbsolute(m.socket)) {
      ctx.addIssue({
        code: 'custom',
        path: ['socket'],
        message: 'socket must be an absolute path',
      });
    }
    if (effectiveTransport(m) !== 'stdio') {
      ctx.addIssue({
        code: 'custom',
        path: ['socket'],
        message: `a "${effectiveTransport(m)}" connector serves no ops: it has no socket`,
      });
    }
  }
  if ((m.exec === undefined) === (m.builtin === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: [m.exec === undefined ? 'exec' : 'builtin'],
      message: 'exactly one of "exec" or "builtin" is required',
    });
    return;
  }
  if (m.builtin === undefined) {
    return;
  }
  for (const field of ['cwd', 'env', 'health'] as const) {
    const v = m[field];
    if (v !== undefined && !(typeof v === 'object' && Object.keys(v).length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `a built-in connector has no process: "${field}" does not apply`,
      });
    }
  }
  if (m.transport === 'stdio') {
    ctx.addIssue({
      code: 'custom',
      path: ['transport'],
      message: 'a built-in connector serves no ops: transport must be "none"',
    });
  }
  BUILTIN_CHECKS[m.builtin](m, ctx);
});

export type ConnectorManifestConfig = z.infer<typeof ConnectorManifest>;

/** A manifest with `transport` and `emits` filled in, `cwd` made absolute and its origin recorded. */
export interface ConnectorConfig extends Omit<ConnectorManifestConfig, 'transport'> {
  transport: Transport;
  /** The manifest file, or the agent.yaml it was inlined in. */
  file: string;
}

/**
 * The socket a `managed_by: systemd` stdio connector serves MCP on: the manifest's
 * `socket`, or `mcp.sock` in the unit's runtime directory. The core connects to it and
 * `247-agent-connector-host` listens on it, so both compute it here.
 */
export function unitSocket(m: { name: string; socket?: string | undefined }): string {
  return m.socket ?? join(UNIT_RUNTIME_ROOT, m.name, 'mcp.sock');
}

export type ConnectorLoadResult =
  | { ok: true; file: string; config: ConnectorConfig }
  | { ok: false; file: string; issues: ConfigIssue[] };

/** True for a YAML document that looks like a manifest (`oa validate` uses it to tell files apart). */
export function looksLikeManifest(doc: unknown): boolean {
  return (
    doc !== null && typeof doc === 'object' && 'name' in doc && ('exec' in doc || 'builtin' in doc)
  );
}

export function parseManifest(doc: unknown, file: string): ConnectorLoadResult {
  const result = ConnectorManifest.safeParse(doc);
  if (!result.success) {
    return { ok: false, file, issues: issuesFromZod(result.error) };
  }
  const c = result.data;
  const base = dirname(resolve(file));
  const event = c.config.event;
  const emits =
    c.builtin === 'poller' && c.emits.length === 0 && typeof event === 'string' ? [event] : c.emits;
  return {
    ok: true,
    file,
    config: {
      ...c,
      transport: effectiveTransport(c),
      emits,
      ...(c.cwd === undefined ? {} : { cwd: resolve(base, c.cwd) }),
      file,
    },
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
