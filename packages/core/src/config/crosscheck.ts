import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { isInsidePath, type ProtectedPath } from '../actions/sandbox.js';
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

/** What `checkSandboxes` needs from agent.yaml and the manifests. */
export interface SandboxCheckContext {
  manifests: readonly ConnectorConfig[];
  /** `defaults.agent.connector`. */
  defaultConnector: string | undefined;
  /** `defaults.agent.work_dir`, resolved: the sandboxed agents' one writable path. */
  workDir: string;
  /** The db, the socket, `agent.yaml`, the secrets file: nothing may bind them in. */
  protected: readonly ProtectedPath[];
}

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
 * Run at daemon start, on reload and by `oa validate agent.yaml`.
 */
export function checkSandboxes(
  tasks: readonly TaskConfig[],
  ctx: SandboxCheckContext,
): SandboxCheckResult {
  const out: SandboxCheckResult = { tasks: [], manifests: [], agent: [] };
  const sandboxed = ctx.manifests.filter(
    (m) => m.transport === 'acp' && m.sandbox !== undefined && m.sandbox.backend !== 'none',
  );
  if (sandboxed.length === 0) {
    return out;
  }
  for (const p of ctx.protected) {
    if (isInside(ctx.workDir, p.path)) {
      out.agent.push({
        path: 'defaults.agent.work_dir',
        message: `${ctx.workDir} contains the ${p.what} ${p.path}, which a sandboxed agent program (connector "${sandboxed.map((m) => m.name).join('", "')}") could then read: move it`,
      });
    }
  }
  const visible = (m: ConnectorConfig, path: string): boolean =>
    isInside(ctx.workDir, path) ||
    [...(m.sandbox?.ro_binds ?? []), ...(m.sandbox?.rw_binds ?? [])].some((b) => isInside(b, path));
  for (const m of sandboxed) {
    const issues: ConfigIssue[] = [];
    for (const list of ['ro_binds', 'rw_binds'] as const) {
      (m.sandbox?.[list] ?? []).forEach((bind, i) => {
        for (const p of ctx.protected) {
          if (isInside(bind, p.path)) {
            issues.push({
              path: `sandbox.${list}[${String(i)}]`,
              message: `${bind} would expose the ${p.what} ${p.path} to the sandboxed agent program`,
            });
          }
        }
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
