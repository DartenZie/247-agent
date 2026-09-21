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
import {
  DecideDefaults,
  type BudgetsConfig,
  type DecideDefaultsConfig,
  type LlmDefaultsConfig,
  type ProviderConfigParsed,
} from './config.js';
import { BudgetExceededError, ProviderUnavailableError, UnpricedModelError } from './errors.js';
import {
  costUsd,
  estimateInputTokens,
  startOfUtcDay,
  utcDay,
  type PricingTable,
} from './pricing.js';
import type {
  DecideCall,
  DecideCallResult,
  LlmCall,
  LlmCallContext,
  LlmCallResult,
  LlmPort,
  LlmProvider,
  LlmUsage,
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
  /** `defaults.decide`; the built-in defaults when omitted. */
  decideDefaults?: DecideDefaultsConfig | undefined;
  budgets: BudgetsConfig;
  factories: ProviderFactories;
}

/** The event the daily circuit breaker emits, once per UTC day (ARCHITECTURE §9). */
export const BUDGET_EXCEEDED = 'budget.exceeded';

/** What `execute` needs to know about a call before and after the adapter runs it. */
interface ExecuteSpec {
  provider: string;
  model: string;
  maxUsd?: number | undefined;
  /** Worst-case usage for the pre-call check, priced from the table. */
  estimate: LlmUsage;
  /** The structured log line's message. */
  msg: 'llm.call' | 'llm.decide';
}

/**
 * The `LlmPort` implementation: prices, budgets and ledgers every call. Budget state is
 * derived from the ledger, so a restart changes nothing. Ordering per call: refuse on the
 * daily cap or a worst-case per-run overrun before contacting the provider; after the call,
 * write the row and trip the breaker if the day's spend crossed the cap. `call` (a model
 * completion) and `decide` (the Decisions API) differ only in the adapter method and the
 * worst-case estimate; everything else is `execute`.
 */
export class LlmService implements LlmPort {
  readonly defaults: LlmDefaultsConfig;
  readonly decideDefaults: DecideDefaultsConfig;
  private readonly o: LlmServiceOptions;

  constructor(opts: LlmServiceOptions) {
    this.o = opts;
    this.defaults = opts.defaults;
    this.decideDefaults = opts.decideDefaults ?? DecideDefaults.parse({});
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
    return this.execute(
      {
        provider: req.provider,
        model: req.model,
        maxUsd: req.maxUsd,
        msg: 'llm.call',
        estimate: {
          input: estimateInputTokens((req.system ?? '') + req.input),
          output: req.maxTokens,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      cctx,
      (adapter) =>
        adapter.complete({
          model: req.model,
          system: req.system,
          input: req.input,
          outputSchema: req.outputSchema,
          maxTokens: req.maxTokens,
          effort: req.effort,
          signal: cctx.signal,
        }),
      (res) => ({ stop_reason: res.stopReason }),
    );
  }

  async decide(req: DecideCall, cctx: LlmCallContext): Promise<DecideCallResult> {
    return this.execute(
      {
        provider: req.provider,
        model: req.model,
        maxUsd: req.maxUsd,
        msg: 'llm.decide',
        // Jev bills input only; the whole JSON body is what it tokenises.
        estimate: {
          input: estimateInputTokens(
            JSON.stringify({ state: req.state, questions: req.questions }),
          ),
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      cctx,
      (adapter) => {
        if (adapter.decide === undefined) {
          throw new ProviderUnavailableError(
            `provider "${req.provider}" (type ${adapter.type}) cannot run decide actions: only openrouter providers reach the Decisions API`,
          );
        }
        return adapter.decide({
          model: req.model,
          state: req.state,
          questions: req.questions,
          signal: cctx.signal,
        });
      },
      (res) => ({ questions: Object.keys(req.questions).length, upstream: res.provider }),
    );
  }

  /**
   * Everything around one adapter call: provider and price lookup, the daily and per-run
   * checks, secret resolution, the ledger row, the breaker, the log line, and the post-hoc
   * budget check. `invoke` is the one adapter method the caller wants.
   */
  private async execute<T extends { usage: LlmUsage }>(
    spec: ExecuteSpec,
    cctx: LlmCallContext,
    invoke: (adapter: LlmProvider) => Promise<T>,
    logFields: (res: T) => Record<string, unknown>,
  ): Promise<T & { usd: number; priced_by: PricedBy; ledgerId: number }> {
    const cfg = this.o.providers[spec.provider];
    if (cfg === undefined) {
      throw new ProviderUnavailableError(`unknown provider "${spec.provider}"`);
    }
    const factory = this.o.factories[cfg.type];
    if (factory === undefined) {
      throw new ProviderUnavailableError(
        `provider type "${cfg.type}" has no adapter in this build`,
      );
    }
    const price = this.o.pricing.get(spec.model);
    if (price === undefined && cfg.type !== 'openrouter') {
      throw new UnpricedModelError(
        `no price for model "${spec.model}" on provider "${spec.provider}": add a pricing entry in agent.yaml`,
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
    if (spec.maxUsd !== undefined) {
      if (spentRun >= spec.maxUsd) {
        throw new BudgetExceededError(
          'task',
          `run budget of $${String(spec.maxUsd)} already spent ($${spentRun.toFixed(4)})`,
        );
      }
      if (price !== undefined) {
        const estimate = costUsd(price, spec.estimate);
        if (spentRun + estimate > spec.maxUsd) {
          throw new BudgetExceededError(
            'task',
            `worst case $${estimate.toFixed(4)} would exceed the run budget of $${String(spec.maxUsd)}; shorten the input, lower max_tokens or raise budget.max_usd`,
          );
        }
      }
    }

    const adapter = factory(this.resolveProvider(spec.provider, cfg));
    const startedAt = Date.now();
    const res = await invoke(adapter);
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
        provider: spec.provider,
        model: spec.model,
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
    cctx.log.info(spec.msg, {
      provider: spec.provider,
      model: spec.model,
      in_tok: res.usage.input,
      out_tok: res.usage.output,
      cache_read: res.usage.cacheRead,
      cache_write: res.usage.cacheWrite,
      usd,
      priced_by: pricedBy,
      duration_ms: durationMs,
      ...logFields(res),
    });
    if (pricedBy === 'unpriced') {
      throw new UnpricedModelError(
        `provider "${spec.provider}" reported no cost for model "${spec.model}" and it has no pricing entry; the tokens are in the ledger at $0`,
      );
    }
    if (spec.maxUsd !== undefined && spentRun + usd > spec.maxUsd) {
      throw new BudgetExceededError(
        'task',
        `run spent $${(spentRun + usd).toFixed(4)}, over its budget of $${String(spec.maxUsd)}`,
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
