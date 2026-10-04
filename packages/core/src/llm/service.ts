import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NonRetryableError } from '../actions/types.js';
import type { EventBus } from '../bus/bus.js';
import { BUDGET_EXCEEDED, LLM_BATCH_ENDED } from '../bus/matcher.js';
import type { Clock } from '../clock.js';
import { isInside } from '../config/crosscheck.js';
import { collectTemplateRefs, renderValue } from '../expr/template.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
import { SecretError, type SecretsBackend } from '../secrets/secrets.js';
import type { PricedBy } from '../store/ledger.js';
import type { BatchRecord } from '../store/batches.js';
import type { Store } from '../store/store.js';
import type { JsonValue } from '../store/types.js';
import {
  BATCH_ABANDON_MS,
  BatchEndedPayload,
  type BatchPollReport,
  type BatchSource,
} from './batches.js';
import {
  DecideDefaults,
  type BudgetsConfig,
  type DecideDefaultsConfig,
  type LlmDefaultsConfig,
  type ProviderConfigParsed,
} from './config.js';
import { BudgetExceededError, ProviderUnavailableError, UnpricedModelError } from './errors.js';
import {
  batchPrice,
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
  BatchCallResult,
  BatchOutcome,
  BatchSubmitResult,
  DecideCall,
  DecideCallResult,
  LlmCall,
  LlmCallContext,
  LlmCallResult,
  LlmPort,
  LlmProvider,
  LlmUsage,
  ProviderFactories,
  ProviderFactory,
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

/** The event the daily circuit breaker emits, once per UTC day (docs/internal/model-actions.md). */
export { BUDGET_EXCEEDED };

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
 * A `batch: true` call is split in two: `submitBatch` does the checks and submits, and
 * `pollBatches` (driven by the `BatchPoller`) settles the batch once it ended: the ledger
 * row at the batch price and the `llm.batch.ended` event, in one transaction.
 */
export class LlmService implements LlmPort, BatchSource {
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

  async submitBatch(req: LlmCall, cctx: LlmCallContext): Promise<BatchSubmitResult> {
    const inFlight = this.o.store.batches.forRun(cctx.run.id);
    if (inFlight !== undefined) {
      // The daemon stopped between submitting and parking the run: wait for that batch.
      cctx.log.info('llm.batch_reused', {
        provider: inFlight.provider,
        batch_id: inFlight.batch_id,
      });
      return { batchId: inFlight.batch_id, reused: true };
    }
    const { cfg, factory, price } = this.lookup(req.provider, req.model);
    const worst =
      price === undefined
        ? undefined
        : costUsd(batchPrice(price), {
            input: estimateInputTokens((req.system ?? '') + req.input),
            output: req.maxTokens,
            cacheRead: 0,
            cacheWrite: 0,
          });
    const { now } = this.precheck({ maxUsd: req.maxUsd, estimate: worst }, cctx);
    // Batches in flight are spend the ledger does not show yet: without reserving their
    // worst case, any number of them would pass the daily cap before the first one ends.
    const dailyCap = this.o.budgets.daily_usd;
    if (dailyCap !== undefined && worst !== undefined) {
      const spentToday = this.o.store.ledger.sumSince(startOfUtcDay(now));
      const reserved = this.o.store.batches.reservedUsd();
      if (spentToday + reserved + worst > dailyCap) {
        this.metrics.budgetExceeded.inc({ scope: 'daily' });
        throw new BudgetExceededError(
          'daily',
          `worst case $${worst.toFixed(4)} with $${reserved.toFixed(4)} reserved by batches in flight and $${spentToday.toFixed(4)} spent today would exceed the daily budget of $${String(dailyCap)}`,
        );
      }
    }
    const adapter = factory(this.resolveProvider(req.provider, cfg));
    if (adapter.submitBatch === undefined || adapter.pollBatch === undefined) {
      throw new ProviderUnavailableError(
        `provider "${req.provider}" (type ${adapter.type}) has no batch API: batch: true needs an anthropic provider`,
      );
    }
    const { batchId } = await adapter.submitBatch({
      model: req.model,
      system: req.system,
      input: req.input,
      outputSchema: req.outputSchema,
      maxTokens: req.maxTokens,
      effort: req.effort,
      signal: cctx.signal,
      customId: cctx.run.id,
    });
    this.o.store.batches.insert({
      batch_id: batchId,
      run_id: cctx.run.id,
      task: cctx.task,
      attempt: cctx.run.attempt,
      provider: req.provider,
      model: req.model,
      structured: req.outputSchema !== undefined,
      worst_usd: worst ?? 0,
      submitted_at: this.o.clock.now().toISOString(),
    });
    this.metrics.llmBatches.inc({ provider: req.provider, status: 'submitted' });
    cctx.log.info('llm.batch_submitted', {
      provider: req.provider,
      model: req.model,
      batch_id: batchId,
    });
    return { batchId, reused: false };
  }

  batchResult(
    payload: JsonValue,
    req: { maxUsd?: number | undefined },
    cctx: LlmCallContext,
  ): BatchCallResult {
    const parsed = BatchEndedPayload.safeParse(payload);
    if (!parsed.success) {
      throw new NonRetryableError(`${LLM_BATCH_ENDED}: unexpected payload`);
    }
    const p = parsed.data;
    if (p.status !== 'succeeded') {
      return {
        status: p.status,
        error: p.error ?? `batch ${p.status}`,
        retryable: p.retryable ?? true,
      };
    }
    if (
      p.usage === undefined ||
      p.usd === undefined ||
      p.priced_by === undefined ||
      p.ledger_id === undefined ||
      p.stop_reason === undefined
    ) {
      throw new NonRetryableError(`${LLM_BATCH_ENDED}: succeeded without its usage`);
    }
    if (p.priced_by === 'unpriced') {
      throw new UnpricedModelError(
        `provider "${p.provider}" reported no cost for model "${p.model}" and it has no pricing entry; the tokens are in the ledger at $0`,
      );
    }
    // The row is already in the ledger: the run is over budget if its total now is.
    this.overrun(req.maxUsd, this.o.store.ledger.sumForRun(cctx.run.id), 0);
    return {
      status: 'succeeded',
      result: {
        output: p.output ?? null,
        text: p.text,
        usage: {
          input: p.usage.input,
          output: p.usage.output,
          cacheRead: p.usage.cache_read,
          cacheWrite: p.usage.cache_write,
        },
        stopReason: p.stop_reason,
        usd: p.usd,
        priced_by: p.priced_by,
        ledgerId: p.ledger_id,
      },
    };
  }

  /**
   * One pass over the batches in flight: each is polled once; an ended one is settled.
   * A batch whose poll fails is tried again next pass, and dropped (logged as an error)
   * once it is older than `BATCH_ABANDON_MS`. Never throws for one batch.
   */
  async pollBatches(signal: AbortSignal): Promise<BatchPollReport> {
    const report: BatchPollReport = { ended: 0, pending: 0, failed: 0, abandoned: 0 };
    // A function, not `signal.aborted` twice: the second read must not be narrowed away.
    const stopping = (): boolean => signal.aborted;
    // One adapter per provider per pass: secrets resolved and a client built once, not per batch.
    const adapters = new Map<string, LlmProvider>();
    for (const row of this.o.store.batches.list()) {
      if (stopping()) {
        break;
      }
      let outcome: Awaited<ReturnType<LlmService['pollBatch']>>;
      try {
        outcome = await this.pollBatch(row, adapters, signal);
      } catch (err) {
        if (stopping()) {
          break; // the daemon is stopping: not a failure of this batch
        }
        report.failed++;
        this.metrics.llmBatches.inc({ provider: row.provider, status: 'poll_failed' });
        this.batchLog(row, this.o.store.runs.getById(row.run_id)?.correlation_id).warn(
          'llm.batch_poll_failed',
          {
            batch_id: row.batch_id,
            provider: row.provider,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        outcome = undefined;
      }
      if (outcome !== undefined) {
        this.settleBatch(row, outcome);
        report.ended++;
        continue;
      }
      const age = this.o.clock.now().getTime() - Date.parse(row.submitted_at);
      if (age > BATCH_ABANDON_MS) {
        this.o.store.batches.delete(row.batch_id);
        report.abandoned++;
        this.metrics.llmBatches.inc({ provider: row.provider, status: 'abandoned' });
        this.batchLog(row, this.o.store.runs.getById(row.run_id)?.correlation_id).error(
          'llm.batch_abandoned',
          {
            batch_id: row.batch_id,
            provider: row.provider,
            submitted_at: row.submitted_at,
          },
        );
      } else {
        report.pending++;
      }
    }
    return report;
  }

  /** The batch's outcome once it ended, `undefined` while it is in progress. */
  private async pollBatch(
    row: BatchRecord,
    adapters: Map<string, LlmProvider>,
    signal: AbortSignal,
  ): Promise<BatchOutcome | undefined> {
    let adapter = adapters.get(row.provider);
    if (adapter === undefined) {
      const { cfg, factory } = this.providerOf(row.provider);
      adapter = factory(this.resolveProvider(row.provider, cfg));
      adapters.set(row.provider, adapter);
    }
    if (adapter.pollBatch === undefined) {
      throw new ProviderUnavailableError(
        `provider "${row.provider}" (type ${adapter.type}) has no batch API in this build`,
      );
    }
    const status = await adapter.pollBatch({
      batchId: row.batch_id,
      customId: row.run_id,
      structured: row.structured,
      signal,
    });
    return status.status === 'in_progress' ? undefined : status;
  }

  /**
   * Ledgers a billed batch at the batch price and publishes `llm.batch.ended` (parented to
   * the run's trigger event, so it shares its correlation) in the transaction that drops
   * the row: a crash before it commits polls the batch again, never ledgers it twice.
   */
  private settleBatch(row: BatchRecord, outcome: BatchOutcome): void {
    const run = this.o.store.runs.getById(row.run_id);
    const log = this.batchLog(row, run?.correlation_id);
    const base = {
      batch_id: row.batch_id,
      run_id: row.run_id,
      task: row.task,
      provider: row.provider,
      model: row.model,
    };
    let status: BatchEndedPayload['status'] = outcome.status;
    this.o.store.transaction(() => {
      let payload: BatchEndedPayload;
      if (outcome.status === 'succeeded') {
        const res = outcome.response;
        let billed: Pick<BatchEndedPayload, 'usd' | 'priced_by' | 'ledger_id'> = {};
        if (run === undefined) {
          // Retention keeps a run while its batch is in flight; only a hand-edited store gets here.
          log.error('llm.batch_orphaned', { batch_id: row.batch_id, in_tok: res.usage.input });
        } else {
          const price = this.o.pricing.get(row.model);
          const settled = this.settle(
            { provider: row.provider, model: row.model, msg: 'llm.call' },
            res.usage,
            price === undefined ? undefined : batchPrice(price),
            this.o.store.ledger.sumForRun(run.id),
            this.o.clock.now(),
            { run, task: row.task, signal: new AbortController().signal, log },
            { batch_id: row.batch_id, stop_reason: res.stopReason },
          );
          billed = { usd: settled.usd, priced_by: settled.pricedBy, ledger_id: settled.ledgerId };
        }
        const usage = {
          input: res.usage.input,
          output: res.usage.output,
          cache_read: res.usage.cacheRead,
          cache_write: res.usage.cacheWrite,
        };
        if (outcome.error !== undefined) {
          status = 'errored';
          payload = { ...base, status, usage, ...billed, error: outcome.error, retryable: true };
        } else {
          payload = {
            ...base,
            status,
            stop_reason: res.stopReason,
            ...(res.output === null ? {} : { output: res.output }),
            ...(res.text === undefined ? {} : { text: res.text }),
            usage,
            ...billed,
          };
        }
      } else {
        payload = { ...base, status, error: outcome.error, retryable: outcome.retryable };
      }
      this.o.bus.publish({
        type: LLM_BATCH_ENDED,
        source: 'core',
        dedup_key: `llm.batch:${row.batch_id}`,
        ...(run === undefined ? {} : { parent_id: run.event_id }),
        payload: payload as JsonValue,
      });
      this.o.store.batches.delete(row.batch_id);
    });
    this.metrics.llmBatches.inc({ provider: row.provider, status });
    log.info('llm.batch_ended', { batch_id: row.batch_id, provider: row.provider, status });
  }

  /** The run's log fields, as the executor sets them, for lines about its batch. */
  private batchLog(row: BatchRecord, correlationId?: string): Logger {
    return this.o.log.child({
      run_id: row.run_id,
      task: row.task,
      ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
    });
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
    const { cfg, factory, price } = this.lookup(spec.provider, spec.model);
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

  /** The provider's config, its adapter factory and the model's price (required unless the provider reports cost). */
  private lookup(
    provider: string,
    model: string,
  ): { cfg: ProviderConfigParsed; factory: ProviderFactory; price: ModelPrice | undefined } {
    const { cfg, factory } = this.providerOf(provider);
    const price = this.o.pricing.get(model);
    if (price === undefined && cfg.type !== 'openrouter') {
      throw new UnpricedModelError(
        `no price for model "${model}" on provider "${provider}": add a pricing entry in agent.yaml`,
      );
    }
    return { cfg, factory, price };
  }

  /** The provider's config and its adapter factory. */
  private providerOf(provider: string): { cfg: ProviderConfigParsed; factory: ProviderFactory } {
    const cfg = this.o.providers[provider];
    if (cfg === undefined) {
      throw new ProviderUnavailableError(`unknown provider "${provider}"`);
    }
    const factory = this.o.factories[cfg.type];
    if (factory === undefined) {
      throw new ProviderUnavailableError(
        `provider type "${cfg.type}" has no adapter in this build`,
      );
    }
    return { cfg, factory };
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
