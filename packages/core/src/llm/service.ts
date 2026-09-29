import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NonRetryableError } from '../actions/types.js';
import type { EventBus } from '../bus/bus.js';
import type { Clock } from '../clock.js';
import { isInside } from '../config/crosscheck.js';
import { collectTemplateRefs, renderValue } from '../expr/template.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
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
  type ModelPrice,
  type PricingTable,
} from './pricing.js';
import type {
  AgentTurn,
  AgentTurnResult,
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
  metrics?: Metrics | undefined;
}

/** What a reload may change: everything from agent.yaml the service reads. */
export type LlmServiceSettings = Pick<
  LlmServiceOptions,
  'providers' | 'pricing' | 'defaults' | 'decideDefaults' | 'budgets' | 'configDir'
>;

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
 * worst-case estimate; everything else is `execute`. An agent turn (`checkBudget` before,
 * `record` after) is the same path with the model call made by the ACP agent itself, so
 * there is no adapter, no estimate and no provider lookup: the row names the connector.
 */
export class LlmService implements LlmPort {
  private o: LlmServiceOptions;
  private readonly metrics: Metrics;

  constructor(opts: LlmServiceOptions) {
    this.o = opts;
    this.metrics = opts.metrics ?? new Metrics();
  }

  get defaults(): LlmDefaultsConfig {
    return this.o.defaults;
  }

  get decideDefaults(): DecideDefaultsConfig {
    return this.o.decideDefaults ?? DecideDefaults.parse({});
  }

  /** Reload seam: calls from now on use the new providers, prices, defaults and budgets. */
  configure(settings: LlmServiceSettings): void {
    this.o = { ...this.o, ...settings };
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

  checkBudget(req: { maxUsd?: number | undefined }, cctx: LlmCallContext): void {
    this.precheck({ maxUsd: req.maxUsd }, cctx);
  }

  record(turn: AgentTurn, cctx: LlmCallContext): AgentTurnResult {
    const price = this.o.pricing.get(turn.model);
    const spentRun = this.o.store.ledger.sumForRun(cctx.run.id);
    const settled = this.settle(
      { provider: turn.provider, model: turn.model, msg: 'agent.turn' },
      turn.usage,
      price,
      spentRun,
      this.o.clock.now(),
      cctx,
      {},
    );
    if (settled.pricedBy === 'unpriced') {
      throw new UnpricedModelError(
        `agent "${turn.provider}" reported no cost and model "${turn.model}" has no pricing entry; the tokens are in the ledger at $0`,
      );
    }
    this.overrun(turn.maxUsd, spentRun, settled.usd);
    return { usd: settled.usd, priced_by: settled.pricedBy, ledgerId: settled.ledgerId };
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
    const { now, spentRun } = this.precheck(
      {
        maxUsd: spec.maxUsd,
        estimate: price === undefined ? undefined : costUsd(price, spec.estimate),
      },
      cctx,
    );

    const adapter = factory(this.resolveProvider(spec.provider, cfg));
    const startedAt = Date.now();
    const res = await invoke(adapter);
    const durationMs = Date.now() - startedAt;
    const settled = this.settle(spec, res.usage, price, spentRun, now, cctx, {
      duration_ms: durationMs,
      ...logFields(res),
    });
    if (settled.pricedBy === 'unpriced') {
      throw new UnpricedModelError(
        `provider "${spec.provider}" reported no cost for model "${spec.model}" and it has no pricing entry; the tokens are in the ledger at $0`,
      );
    }
    this.overrun(spec.maxUsd, spentRun, settled.usd);
    return { ...res, usd: settled.usd, priced_by: settled.pricedBy, ledgerId: settled.ledgerId };
  }

  /**
   * The checks before any spend: the daily cap (tripping the breaker when it is already
   * reached), the run's own cap, and, when a worst-case `estimate` is known, that it fits.
   */
  private precheck(
    req: { maxUsd?: number | undefined; estimate?: number | undefined },
    cctx: LlmCallContext,
  ): { now: Date; spentRun: number } {
    const now = this.o.clock.now();
    const day = utcDay(now);
    const dailyCap = this.o.budgets.daily_usd;
    const spentToday = this.o.store.ledger.sumSince(startOfUtcDay(now));
    if (dailyCap !== undefined && spentToday >= dailyCap) {
      this.tripBreaker(day, dailyCap, spentToday, cctx);
      this.metrics.budgetExceeded.inc({ scope: 'daily' });
      throw new BudgetExceededError(
        'daily',
        `daily budget of $${String(dailyCap)} reached ($${spentToday.toFixed(4)} spent today); model-backed tasks resume at 00:00 UTC`,
      );
    }
    const spentRun = this.o.store.ledger.sumForRun(cctx.run.id);
    if (req.maxUsd !== undefined) {
      if (spentRun >= req.maxUsd) {
        this.metrics.budgetExceeded.inc({ scope: 'task' });
        throw new BudgetExceededError(
          'task',
          `run budget of $${String(req.maxUsd)} already spent ($${spentRun.toFixed(4)})`,
        );
      }
      if (req.estimate !== undefined && spentRun + req.estimate > req.maxUsd) {
        this.metrics.budgetExceeded.inc({ scope: 'task' });
        throw new BudgetExceededError(
          'task',
          `worst case $${req.estimate.toFixed(4)} would exceed the run budget of $${String(req.maxUsd)}; shorten the input, lower max_tokens or raise budget.max_usd`,
        );
      }
    }
    return { now, spentRun };
  }

  /** Prices the usage, writes the ledger row, trips the breaker if due, logs the line. */
  private settle(
    spec: { provider: string; model: string; msg: string },
    usage: LlmUsage,
    price: ModelPrice | undefined,
    spentRun: number,
    now: Date,
    cctx: LlmCallContext,
    logFields: Record<string, unknown>,
  ): { usd: number; pricedBy: PricedBy; ledgerId: number } {
    let usd: number;
    let pricedBy: PricedBy;
    if (usage.reportedUsd !== undefined) {
      usd = usage.reportedUsd;
      pricedBy = 'provider';
    } else if (price !== undefined) {
      usd = costUsd(price, usage);
      pricedBy = 'table';
    } else {
      usd = 0;
      pricedBy = 'unpriced';
    }
    const day = utcDay(now);
    const dailyCap = this.o.budgets.daily_usd;
    const spentToday = this.o.store.ledger.sumSince(startOfUtcDay(now));
    const ledgerId = this.o.store.transaction(() => {
      const id = this.o.store.ledger.insert({
        run_id: cctx.run.id,
        task: cctx.task,
        provider: spec.provider,
        model: spec.model,
        in_tok: usage.input,
        out_tok: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        usd,
        priced_by: pricedBy,
        ts: now.toISOString(),
      });
      if (dailyCap !== undefined && spentToday + usd >= dailyCap) {
        this.tripBreaker(day, dailyCap, spentToday + usd, cctx);
      }
      return id;
    });
    const labels = { provider: spec.provider, model: spec.model };
    this.metrics.modelCalls.inc({ ...labels, task: cctx.task });
    this.metrics.modelCost.inc({ ...labels, task: cctx.task }, usd);
    this.metrics.modelTokens.inc({ ...labels, direction: 'input' }, usage.input);
    this.metrics.modelTokens.inc({ ...labels, direction: 'output' }, usage.output);
    this.metrics.modelTokens.inc({ ...labels, direction: 'cache_read' }, usage.cacheRead);
    this.metrics.modelTokens.inc({ ...labels, direction: 'cache_write' }, usage.cacheWrite);
    cctx.log.info(spec.msg, {
      provider: spec.provider,
      model: spec.model,
      in_tok: usage.input,
      out_tok: usage.output,
      cache_read: usage.cacheRead,
      cache_write: usage.cacheWrite,
      usd,
      priced_by: pricedBy,
      run_usd: spentRun + usd,
      ...logFields,
    });
    return { usd, pricedBy, ledgerId };
  }

  private overrun(maxUsd: number | undefined, spentRun: number, usd: number): void {
    if (maxUsd !== undefined && spentRun + usd > maxUsd) {
      this.metrics.budgetExceeded.inc({ scope: 'task' });
      throw new BudgetExceededError(
        'task',
        `run spent $${(spentRun + usd).toFixed(4)}, over its budget of $${String(maxUsd)}`,
      );
    }
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
