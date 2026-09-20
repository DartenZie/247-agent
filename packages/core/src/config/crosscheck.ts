import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import type { LlmDefaultsConfig, ProviderConfigParsed } from '../llm/config.js';
import type { PricingTable } from '../llm/pricing.js';
import type { ConfigIssue } from './load.js';
import type { TaskConfig } from './schema.js';

export interface LlmCheckContext {
  providers: Readonly<Record<string, ProviderConfigParsed>>;
  pricing: PricingTable;
  defaults: LlmDefaultsConfig;
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
 * `llm` task names a configured provider, a model with a known price (unless the provider
 * reports cost itself), and a `system_file` that exists under the config directory. Run at
 * daemon start, on reload and by `oa validate agent.yaml`, so no unpriced call can be
 * configured.
 */
export function checkLlmTasks(tasks: readonly TaskConfig[], ctx: LlmCheckContext): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  tasks.forEach((task, i) => {
    const a = task.action;
    if (a.kind !== 'llm') {
      return;
    }
    const at = (field: string): string => `tasks[${String(i)}].action.${field}`;
    const providerName = a.provider ?? ctx.defaults.provider;
    const model = a.model ?? ctx.defaults.model;
    if (providerName === undefined) {
      issues.push({
        path: at('provider'),
        message: 'no provider: set action.provider or defaults.llm.provider in agent.yaml',
      });
    }
    if (model === undefined) {
      issues.push({
        path: at('model'),
        message: 'no model: set action.model or defaults.llm.model in agent.yaml',
      });
    }
    const provider = providerName === undefined ? undefined : ctx.providers[providerName];
    if (providerName !== undefined && provider === undefined) {
      issues.push({
        path: at('provider'),
        message: `unknown provider "${providerName}" (not in providers: of agent.yaml)`,
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
    if (a.system_file !== undefined) {
      const path = resolve(ctx.configDir, a.system_file);
      if (!isInside(ctx.configDir, path)) {
        issues.push({
          path: at('system_file'),
          message: `system_file must stay under the config directory ${ctx.configDir}`,
        });
      } else if (!existsSync(path) || !statSync(path).isFile()) {
        issues.push({ path: at('system_file'), message: `system_file not found: ${path}` });
      }
    }
  });
  return issues;
}
