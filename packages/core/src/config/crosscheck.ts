import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  DecideDefaults,
  type DecideDefaultsConfig,
  type LlmDefaultsConfig,
  type ProviderConfigParsed,
} from '../llm/config.js';
import type { PricingTable } from '../llm/pricing.js';
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
export function isInside(dir: string, target: string): boolean {
  const base = resolve(dir);
  const t = resolve(target);
  return t === base || t.startsWith(base + sep);
}

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
