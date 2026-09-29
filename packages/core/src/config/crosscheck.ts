import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  canonicalPath,
  isInsidePath,
  type ProtectedPath,
  type SandboxConfig,
} from '../actions/sandbox.js';
import type { ShellActionConfig } from '../actions/shell.js';
import {
  DecideDefaults,
  type DecideDefaultsConfig,
  type LlmDefaultsConfig,
  type ProviderConfigParsed,
} from '../llm/config.js';
import type { PricingTable } from '../llm/pricing.js';
import type { ConnectorConfig } from './connector.js';
import type { ConfigIssue } from './load.js';
import type { TaskConfig } from './schema.js';

export interface LlmCheckContext {
  providers: Readonly<Record<string, ProviderConfigParsed>>;
  pricing: PricingTable;
  defaults: LlmDefaultsConfig;
  /** `defaults.decide`; the built-in defaults when omitted. */
  decideDefaults?: DecideDefaultsConfig | undefined;
  /** The agent.yaml directory, which `system_file` is relative to. */
  configDir: string;
}

/** True when `target` is `dir` itself or inside it. */
export const isInside = isInsidePath;

/**
 * What a tasks file cannot check on its own (it is validated without agent.yaml): every
 * `llm` and `decide` task names a configured provider and a model with a known price (unless
 * the provider reports cost itself); an `llm` task's `system_file` exists under the config
 * directory; a `decide` task's provider is of type `openrouter`, the only one that serves the
 * Decisions API; an `agent` task's `model` (when set), `system_file` and `result.schema`
 * likewise. Run at daemon start, on reload and by `oa validate agent.yaml`, so no unpriced
 * call can be configured.
 */
export function checkLlmTasks(tasks: readonly TaskConfig[], ctx: LlmCheckContext): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const decideDefaults = ctx.decideDefaults ?? DecideDefaults.parse({});
  const fileUnder = (field: string, relative: string, path: string): void => {
    const abs = resolve(ctx.configDir, relative);
    if (!isInside(ctx.configDir, abs)) {
      issues.push({
        path,
        message: `${field} must stay under the config directory ${ctx.configDir}`,
      });
    } else if (!existsSync(abs) || !statSync(abs).isFile()) {
      issues.push({ path, message: `${field} not found: ${abs}` });
    }
  };
  tasks.forEach((task, i) => {
    const a = task.action;
    const at = (field: string): string => `tasks[${String(i)}].action.${field}`;
    if (a.kind === 'agent') {
      // The agent makes its own model calls; `model` only prices what it reports, so it
      // must be priced when set. The connector is checked against the manifests by the core.
      if (a.model !== undefined && !ctx.pricing.has(a.model)) {
        issues.push({
          path: at('model'),
          message: `no price for model "${a.model}": add a pricing entry in agent.yaml (or omit model when the agent reports cost)`,
        });
      }
      if (a.system_file !== undefined) {
        fileUnder('system_file', a.system_file, at('system_file'));
      }
      if (a.result.schema !== undefined) {
        fileUnder('result.schema', a.result.schema, at('result.schema'));
      }
      return;
    }
    if (a.kind !== 'llm' && a.kind !== 'decide') {
      return;
    }
    const section = a.kind === 'llm' ? 'defaults.llm' : 'defaults.decide';
    const providerName =
      a.provider ?? (a.kind === 'llm' ? ctx.defaults.provider : decideDefaults.provider);
    const model = a.model ?? (a.kind === 'llm' ? ctx.defaults.model : decideDefaults.model);
    if (providerName === undefined) {
      issues.push({
        path: at('provider'),
        message: `no provider: set action.provider or ${section}.provider in agent.yaml`,
      });
    }
    if (model === undefined) {
      issues.push({
        path: at('model'),
        message: `no model: set action.model or ${section}.model in agent.yaml`,
      });
    }
    const provider = providerName === undefined ? undefined : ctx.providers[providerName];
    if (providerName !== undefined && provider === undefined) {
      issues.push({
        path: at('provider'),
        message: `unknown provider "${providerName}" (not in providers: of agent.yaml)`,
      });
    }
    if (a.kind === 'decide' && provider !== undefined && provider.type !== 'openrouter') {
      issues.push({
        path: at('provider'),
        message: `decide needs an openrouter provider (the Decisions API); "${String(providerName)}" is type ${provider.type}`,
      });
    }
    if (
      provider !== undefined &&
      providerName !== undefined &&
      model !== undefined &&
      provider.type !== 'openrouter' &&
      !ctx.pricing.has(model)
    ) {
      issues.push({
        path: at('model'),
        message: `no price for model "${model}" on provider "${providerName}" (type ${provider.type}): add a pricing entry in agent.yaml`,
      });
    }
    if (a.kind === 'llm' && a.system_file !== undefined) {
      fileUnder('system_file', a.system_file, at('system_file'));
    }
  });
  return issues;
}

/**
 * An `agent` task's `mcp_servers` (§5.4, §6) name process connectors that serve ops
 * (`transport: stdio`), and any ops they list are in the manifest's own `ops` when it
 * has some: the tool bridge serves nothing else. Run with the manifests at daemon start,
 * on reload and by `oa validate agent.yaml`.
 */
export function checkAgentTools(
  tasks: readonly TaskConfig[],
  manifests: readonly ConnectorConfig[],
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  tasks.forEach((task, i) => {
    const a = task.action;
    if (a.kind !== 'agent') {
      return;
    }
    a.mcp_servers.forEach((grant, j) => {
      const path = `tasks[${String(i)}].action.mcp_servers[${String(j)}]`;
      const m = manifests.find((x) => x.name === grant.connector);
      if (m === undefined) {
        issues.push({ path, message: `unknown connector "${grant.connector}"` });
        return;
      }
      if (m.transport !== 'stdio' || m.builtin !== undefined) {
        issues.push({
          path,
          message: `connector "${m.name}" serves no ops (${m.builtin === undefined ? `transport ${m.transport}` : `built-in ${m.builtin}`}); only a stdio connector can be an agent's tools`,
        });
        return;
      }
      const missing = m.ops.length === 0 ? [] : grant.ops.filter((op) => !m.ops.includes(op));
      if (missing.length > 0) {
        issues.push({
          path: `${path}.ops`,
          message: `not in the ops of connector "${m.name}" (${m.file}): ${missing.join(', ')}`,
        });
      }
    });
  });
  return issues;
}

/** What `checkSandboxes` needs from agent.yaml and the manifests. */
export interface SandboxCheckContext {
  manifests: readonly ConnectorConfig[];
  /** `defaults.agent.connector`. */
  defaultConnector: string | undefined;
  /** `defaults.agent.work_dir`, resolved: the sandboxed agents' one writable path. */
  workDir: string;
  /** The db, the socket, `agent.yaml`, the secrets file: nothing may bind them in. */
  protected: readonly ProtectedPath[];
  /** `defaults.sandbox`: what a `shell` action without its own `sandbox` runs in. */
  defaultSandbox?: SandboxConfig | undefined;
}

/** Issues for the protected paths a bind would show, one per file, all with the same `path`. */
type Exposes = (bind: string, path: string, who: string) => ConfigIssue[];

export interface SandboxCheckResult {
  /** On the tasks, with merged-list paths (`tasks[i]…`). */
  tasks: ConfigIssue[];
  /** On a manifest, by the file it came from. */
  manifests: { file: string; issues: ConfigIssue[] }[];
  /** On agent.yaml itself. */
  agent: ConfigIssue[];
}

/**
 * A sandboxed agent program (a `transport: acp` manifest with `sandbox: bwrap`, §5.4,
 * §11) sees the OS, the install, `work_dir` and the manifest's own binds, nothing else. So:
 * no bind (nor `work_dir`) may contain the database, the socket, `agent.yaml` or the
 * secrets file, which the sandbox exists to hide; the manifest's `cwd` must lie inside a
 * bind; and the repository of every `git-worktree` workspace an `agent` task opens on
 * that connector must lie inside a bind, or the worktree's `.git` link points nowhere.
 * A sandboxed `shell` action (§5.1) binds its `cwd` read-write and its binds likewise, so
 * the same rule holds for them. Paths are compared with symlinks resolved on both sides,
 * as bwrap mounts what a bind's source really is. Run at daemon start, on reload and by
 * `oa validate agent.yaml`.
 */
export function checkSandboxes(
  tasks: readonly TaskConfig[],
  ctx: SandboxCheckContext,
): SandboxCheckResult {
  const out: SandboxCheckResult = { tasks: [], manifests: [], agent: [] };
  const inside = (dir: string, target: string): boolean =>
    isInside(canonicalPath(dir), canonicalPath(target));
  const exposes: Exposes = (bind, path, who) =>
    ctx.protected
      .filter((p) => inside(bind, p.path))
      .map((p) => ({ path, message: `${bind} would expose the ${p.what} ${p.path} to ${who}` }));
  checkShellSandboxes(tasks, ctx, exposes, out);
  const sandboxed = ctx.manifests.filter(
    (m) => m.transport === 'acp' && m.sandbox !== undefined && m.sandbox.backend !== 'none',
  );
  if (sandboxed.length === 0) {
    return out;
  }
  for (const p of ctx.protected) {
    if (inside(ctx.workDir, p.path)) {
      out.agent.push({
        path: 'defaults.agent.work_dir',
        message: `${ctx.workDir} contains the ${p.what} ${p.path}, which a sandboxed agent program (connector "${sandboxed.map((m) => m.name).join('", "')}") could then read: move it`,
      });
    }
  }
  const visible = (m: ConnectorConfig, path: string): boolean =>
    inside(ctx.workDir, path) ||
    [...(m.sandbox?.ro_binds ?? []), ...(m.sandbox?.rw_binds ?? [])].some((b) => inside(b, path));
  for (const m of sandboxed) {
    const issues: ConfigIssue[] = [];
    for (const list of ['ro_binds', 'rw_binds'] as const) {
      (m.sandbox?.[list] ?? []).forEach((bind, i) => {
        issues.push(
          ...exposes(bind, `sandbox.${list}[${String(i)}]`, 'the sandboxed agent program'),
        );
      });
    }
    if (m.cwd !== undefined && !visible(m, m.cwd)) {
      issues.push({
        path: 'cwd',
        message: `${m.cwd} is not visible inside the sandbox: put it under work_dir or list it in sandbox.ro_binds`,
      });
    }
    if (issues.length > 0) {
      out.manifests.push({ file: m.file, issues });
    }
  }
  tasks.forEach((task, i) => {
    const a = task.action;
    if (a.kind !== 'agent' || a.workspace.kind !== 'git-worktree') {
      return;
    }
    const name = a.connector ?? ctx.defaultConnector;
    const m = sandboxed.find((x) => x.name === name);
    if (m === undefined || visible(m, a.workspace.repo)) {
      return;
    }
    out.tasks.push({
      path: `tasks[${String(i)}].action.workspace.repo`,
      message: `${a.workspace.repo} is not visible to the sandboxed agent program "${m.name}": add it to sandbox.ro_binds in ${m.file} (rw_binds if the agent itself commits)`,
    });
  });
  return out;
}

type ShellLike = Pick<ShellActionConfig, 'cwd' | 'sandbox'>;

/**
 * The `shell` actions of a task (its own or its sequence's steps) with the issue path
 * prefix of each.
 */
function shellActions(task: TaskConfig, at: string): { shell: ShellLike; at: string }[] {
  const a = task.action;
  if (a.kind === 'shell') {
    return [{ shell: a, at }];
  }
  if (a.kind !== 'sequence') {
    return [];
  }
  return a.steps.flatMap((s, k) =>
    s.kind === 'shell' ? [{ shell: s, at: `${at}.steps[${String(k)}]` }] : [],
  );
}

/**
 * A `shell` action in bwrap binds its `cwd` read-write and its sandbox's binds (§5.1), a
 * `defaults.sandbox` bind every such action: none may hold a protected file. A templated
 * or relative `cwd` is only known at run time and is not checked.
 */
function checkShellSandboxes(
  tasks: readonly TaskConfig[],
  ctx: SandboxCheckContext,
  exposes: Exposes,
  out: SandboxCheckResult,
): void {
  const defaults = ctx.defaultSandbox;
  if (defaults !== undefined && defaults.backend !== 'none') {
    for (const list of ['ro_binds', 'rw_binds'] as const) {
      defaults[list].forEach((bind, j) => {
        out.agent.push(
          ...exposes(
            bind,
            `defaults.sandbox.${list}[${String(j)}]`,
            'every sandboxed shell action',
          ),
        );
      });
    }
  }
  tasks.forEach((task, i) => {
    for (const { shell, at } of shellActions(task, `tasks[${String(i)}].action`)) {
      const sandbox = shell.sandbox ?? defaults;
      if (sandbox === undefined || sandbox.backend === 'none') {
        continue;
      }
      const who = 'the sandboxed command';
      if (shell.cwd !== undefined && isAbsolute(shell.cwd) && !shell.cwd.includes('${')) {
        out.tasks.push(...exposes(shell.cwd, `${at}.cwd`, who));
      }
      if (shell.sandbox !== undefined) {
        for (const list of ['ro_binds', 'rw_binds'] as const) {
          shell.sandbox[list].forEach((bind, j) => {
            out.tasks.push(...exposes(bind, `${at}.sandbox.${list}[${String(j)}]`, who));
          });
        }
      }
    }
  });
}
