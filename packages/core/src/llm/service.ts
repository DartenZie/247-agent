import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NonRetryableError } from '../actions/types.js';
import type { EventBus } from '../bus/bus.js';
import type { Clock } from '../clock.js';
import { isInside } from '../config/crosscheck.js';
import { collectTemplateRefs, renderValue } from '../expr/template.js';
import type { Logger } from '../log.js';
import { SecretError, type SecretsBackend } from '../secrets/secrets.js';
import type { PricedBy } from '../store/ledger.js';
import type { Store } from '../store/store.js';
import type { BudgetsConfig, LlmDefaultsConfig, ProviderConfigParsed } from './config.js';
import { BudgetExceededError, ProviderUnavailableError, UnpricedModelError } from './errors.js';
import {
  costUsd,
  estimateInputTokens,
  startOfUtcDay,
  utcDay,
  type PricingTable,
} from './pricing.js';
import type {
  LlmCall,
  LlmCallContext,
  LlmCallResult,
  LlmPort,
  ProviderFactories,
  ResolvedProvider,
} from './types.js';

export interface LlmServiceOptions {
  store: Store;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  secrets: SecretsBackend;
  /** The `env` template scope for `providers.*.headers`. */
  env?: Record<string, string> | undefined;
  /** The agent.yaml directory; `system_file` paths are relative to it. */
  configDir: string;
  providers: Readonly<Record<string, ProviderConfigParsed>>;
  pricing: PricingTable;
  defaults: LlmDefaultsConfig;
  budgets: BudgetsConfig;
  factories: ProviderFactories;
}

/** The event the daily circuit breaker emits, once per UTC day (ARCHITECTURE §9). */
export const BUDGET_EXCEEDED = 'budget.exceeded';

/**
 * The `LlmPort` implementation: prices, budgets and ledgers every call. Budget state is
 * derived from the ledger, so a restart changes nothing. Ordering per call: refuse on the
 * daily cap or a worst-case per-run overrun before contacting the provider; after the call,
 * write the row and trip the breaker if the day's spend crossed the cap.
 */
export class LlmService implements LlmPort {
  readonly defaults: LlmDefaultsConfig;
  private readonly o: LlmServiceOptions;

  constructor(opts: LlmServiceOptions) {
    this.o = opts;
    this.defaults = opts.defaults;
  }

  providers(): string[] {
    return Object.keys(this.o.providers);
  }

  readSystemFile(relative: string): string {
    const path = resolve(this.o.configDir, relative);
    if (!isInside(this.o.configDir, path)) {
      throw new NonRetryableError(`system_file must stay under ${this.o.configDir}: ${relative}`);
    }
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      throw new NonRetryableError(
        `cannot read system_file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async call(req: LlmCall, cctx: LlmCallContext): Promise<LlmCallResult> {
    const cfg = this.o.providers[req.provider];
    if (cfg === undefined) {
      throw new ProviderUnavailableError(`unknown provider "${req.provider}"`);
    }
    const factory = this.o.factories[cfg.type];
    if (factory === undefined) {
      throw new ProviderUnavailableError(
        `provider type "${cfg.type}" has no adapter in this build`,
      );
    }
    const price = this.o.pricing.get(req.model);
    if (price === undefined && cfg.type !== 'openrouter') {
      throw new UnpricedModelError(
        `no price for model "${req.model}" on provider "${req.provider}": add a pricing entry in agent.yaml`,
      );
    }

    const now = this.o.clock.now();
    const day = utcDay(now);
    const dailyCap = this.o.budgets.daily_usd;
    const spentToday = this.o.store.ledger.sumSince(startOfUtcDay(now));
    if (dailyCap !== undefined && spentToday >= dailyCap) {
      this.tripBreaker(day, dailyCap, spentToday, cctx);
      throw new BudgetExceededError(
        'daily',
        `daily budget of $${String(dailyCap)} reached ($${spentToday.toFixed(4)} spent today); model-backed tasks resume at 00:00 UTC`,
      );
    }
    const spentRun = this.o.store.ledger.sumForRun(cctx.run.id);
    if (req.maxUsd !== undefined) {
      if (spentRun >= req.maxUsd) {
        throw new BudgetExceededError(
          'task',
          `run budget of $${String(req.maxUsd)} already spent ($${spentRun.toFixed(4)})`,
        );
      }
      if (price !== undefined) {
        const estimate = costUsd(price, {
          input: estimateInputTokens((req.system ?? '') + req.input),
          output: req.maxTokens,
          cacheRead: 0,
          cacheWrite: 0,
        });
        if (spentRun + estimate > req.maxUsd) {
          throw new BudgetExceededError(
            'task',
            `worst case $${estimate.toFixed(4)} would exceed the run budget of $${String(req.maxUsd)}; lower max_tokens or raise budget.max_usd`,
          );
        }
      }
    }

    const provider = factory(this.resolveProvider(req.provider, cfg));
    const startedAt = Date.now();
    const res = await provider.complete({
      model: req.model,
      system: req.system,
      input: req.input,
      outputSchema: req.outputSchema,
      maxTokens: req.maxTokens,
      effort: req.effort,
      signal: cctx.signal,
    });
    const durationMs = Date.now() - startedAt;

    let usd: number;
    let pricedBy: PricedBy;
    if (res.usage.reportedUsd !== undefined) {
      usd = res.usage.reportedUsd;
      pricedBy = 'provider';
    } else if (price !== undefined) {
      usd = costUsd(price, res.usage);
      pricedBy = 'table';
    } else {
      usd = 0;
      pricedBy = 'unpriced';
    }
    const ledgerId = this.o.store.transaction(() => {
      const id = this.o.store.ledger.insert({
        run_id: cctx.run.id,
        task: cctx.task,
        provider: req.provider,
        model: req.model,
        in_tok: res.usage.input,
        out_tok: res.usage.output,
        cache_read: res.usage.cacheRead,
        cache_write: res.usage.cacheWrite,
        usd,
        priced_by: pricedBy,
        ts: now.toISOString(),
      });
      if (dailyCap !== undefined && spentToday + usd >= dailyCap) {
        this.tripBreaker(day, dailyCap, spentToday + usd, cctx);
      }
      return id;
    });
    cctx.log.info('llm.call', {
      provider: req.provider,
      model: req.model,
      in_tok: res.usage.input,
      out_tok: res.usage.output,
      cache_read: res.usage.cacheRead,
      cache_write: res.usage.cacheWrite,
      usd,
      priced_by: pricedBy,
      stop_reason: res.stopReason,
      duration_ms: durationMs,
    });
    if (pricedBy === 'unpriced') {
      throw new UnpricedModelError(
        `provider "${req.provider}" reported no cost for model "${req.model}" and it has no pricing entry; the tokens are in the ledger at $0`,
      );
    }
    if (req.maxUsd !== undefined && spentRun + usd > req.maxUsd) {
      throw new BudgetExceededError(
        'task',
        `run spent $${(spentRun + usd).toFixed(4)}, over its budget of $${String(req.maxUsd)}`,
      );
    }
    return { ...res, usd, priced_by: pricedBy, ledgerId };
  }

  /** Renders `api_key`/`headers` with freshly resolved secrets; nothing is kept between calls. */
  private resolveProvider(name: string, cfg: ProviderConfigParsed): ResolvedProvider {
    const refs = collectTemplateRefs({ api_key: cfg.api_key, headers: cfg.headers });
    let secrets: Record<string, string>;
    try {
      secrets = this.o.secrets.resolve(refs.secrets);
    } catch (err) {
      if (err instanceof SecretError) {
        throw new NonRetryableError(`provider "${name}": ${err.message}`);
      }
      throw err;
    }
    const scope = { secrets, env: this.o.env ?? {} };
    const apiKey = renderValue(cfg.api_key, scope);
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new NonRetryableError(`provider "${name}": api_key resolved to an empty value`);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      renderValue(cfg.headers, scope) as Record<string, unknown>,
    )) {
      headers[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return { name, type: cfg.type, apiKey, baseUrl: cfg.base_url, headers };
  }

  private tripBreaker(day: string, limit: number, spent: number, cctx: LlmCallContext): void {
    const result = this.o.bus.publish({
      type: BUDGET_EXCEEDED,
      source: 'core',
      dedup_key: `budget:daily:${day}`,
      payload: {
        scope: 'daily',
        day,
        limit_usd: limit,
        spent_usd: spent,
        task: cctx.task,
        run_id: cctx.run.id,
      },
    });
    if (result.status === 'inserted') {
      cctx.log.warn(BUDGET_EXCEEDED, { day, limit_usd: limit, spent_usd: spent });
    }
  }
}
