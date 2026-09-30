import type { Logger } from '../log.js';
import type { PricedBy } from '../store/ledger.js';
import type { JsonValue, RunRecord } from '../store/types.js';
import type { DecideDefaultsConfig, Effort, LlmDefaultsConfig, ProviderType } from './config.js';

/** What a provider adapter receives: rendered, with secrets already resolved. */
export interface LlmRequest {
  model: string;
  /** Static, so adapters can mark it for prompt caching. */
  system?: string | undefined;
  input: string;
  /** JSON Schema for the structured output; without it the adapter returns plain text. */
  outputSchema?: Record<string, unknown> | undefined;
  maxTokens: number;
  /** Adapters omit it on models that have no effort parameter. */
  effort?: Effort | undefined;
  signal: AbortSignal;
}

/**
 * Token counts as billed. `input` is what the provider charges at the full input price:
 * Anthropic reports cache tokens separately, OpenAI reports them as a subset of its input
 * count, so each adapter normalises to this shape.
 */
export interface LlmUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The cost the provider itself reported (OpenRouter); wins over the price table. */
  reportedUsd?: number | undefined;
}

export type StopReason = 'end' | 'max_tokens' | 'refusal' | 'other';

export interface LlmResponse {
  /** The parsed structured output, or `null` when the request had no schema. */
  output: JsonValue;
  /** The raw text when the request had no schema. */
  text?: string | undefined;
  usage: LlmUsage;
  stopReason: StopReason;
}

/** What a `decide` action asks the model to judge: text, or a JSON document (ARCHITECTURE §5.3). */
export type DecideState = string | JsonValue[] | Record<string, JsonValue>;

/**
 * One typed question for the Decisions API. `noul` is a yes/no proposition, `choice` picks
 * one label, `score` places the state on an ordered scale (index 0 lowest). Instructions
 * and criteria are static policy; the volatile content is the `state`.
 */
export type DecideQuestion =
  | {
      type: 'noul';
      instructions: string;
      criteria?: { true: string; false: string } | undefined;
    }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

/** One answer as the Decisions API returns it. `noul` is P(true); `score` is the probability-weighted mean level. */
export type DecideAnswer =
  | { type: 'noul'; noul: number }
  | {
      type: 'choice';
      choice: string;
      confidence?: number | undefined;
      probabilities?: Record<string, number> | undefined;
    }
  | {
      type: 'score';
      score: number;
      confidence?: number | undefined;
      probabilities?: Record<string, number> | undefined;
      legend?: Record<string, string> | undefined;
    };

/** What a provider adapter receives for a decision: rendered, secrets resolved. */
export interface DecideRequest {
  model: string;
  state: DecideState;
  questions: Record<string, DecideQuestion>;
  signal: AbortSignal;
}

export interface DecideResponse {
  answers: Record<string, DecideAnswer>;
  /** `input` = input tokens, `output` = output tokens, no cache columns; `reportedUsd` = the provider's cost. */
  usage: LlmUsage;
  /** The provider's response id and the upstream that served it, for the log line. */
  id?: string | undefined;
  provider?: string | undefined;
}

/** One request for a Message Batches API: a completion, identified by `customId` in its batch. */
export interface BatchSubmitRequest extends LlmRequest {
  /** `[A-Za-z0-9_-]{1,64}`; the run id. */
  customId: string;
}

/** What a batch came to. `succeeded` is billed; the others are not. */
export type BatchOutcome =
  | {
      status: 'succeeded';
      response: LlmResponse;
      /** Set when the response is billed but unusable (a structured output that is not JSON). */
      error?: string | undefined;
    }
  | {
      status: 'errored' | 'expired' | 'canceled';
      error: string;
      /** `false` for a request the provider rejected as invalid: resubmitting cannot help. */
      retryable: boolean;
    };

export type BatchStatus = { status: 'in_progress' } | BatchOutcome;

export interface BatchPollRequest {
  batchId: string;
  customId: string;
  /** Whether the request had a schema: the result text is then parsed as JSON. */
  structured: boolean;
  signal: AbortSignal;
}

/** One provider adapter, built per call from the resolved config. */
export interface LlmProvider {
  readonly name: string;
  readonly type: ProviderType;
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** The Decisions API; only provider types that serve it implement this. */
  decide?(req: DecideRequest): Promise<DecideResponse>;
  /**
   * A Message Batches API (`batch: true`); only provider types that serve one implement
   * this pair. `submitBatch` returns the batch id; `pollBatch` reports it in progress or
   * fetches its one result.
   */
  submitBatch?(req: BatchSubmitRequest): Promise<{ batchId: string }>;
  pollBatch?(req: BatchPollRequest): Promise<BatchStatus>;
}

/** A `providers.<name>` entry with its templates rendered. Never logged, never stored. */
export interface ResolvedProvider {
  name: string;
  type: ProviderType;
  apiKey: string;
  baseUrl?: string | undefined;
  headers: Record<string, string>;
}

export type ProviderFactory = (provider: ResolvedProvider) => LlmProvider;

/** One factory per provider type; a type without one fails with `ProviderUnavailableError`. */
export type ProviderFactories = Partial<Record<ProviderType, ProviderFactory>>;

/** What an action asks the port for. */
export interface LlmCall {
  provider: string;
  model: string;
  system?: string | undefined;
  input: string;
  outputSchema?: Record<string, unknown> | undefined;
  maxTokens: number;
  effort?: Effort | undefined;
  /** The run's cap (the smaller of the task's and the action's `budget.max_usd`), if any. */
  maxUsd?: number | undefined;
}

export interface LlmCallContext {
  run: RunRecord;
  task: string;
  signal: AbortSignal;
  log: Logger;
}

export interface LlmCallResult extends LlmResponse {
  usd: number;
  priced_by: PricedBy;
  ledgerId: number;
}

/** What a `decide` action asks the port for. */
export interface DecideCall {
  provider: string;
  model: string;
  state: DecideState;
  questions: Record<string, DecideQuestion>;
  /** The run's cap (the smaller of the task's and the action's `budget.max_usd`), if any. */
  maxUsd?: number | undefined;
}

export interface DecideCallResult extends DecideResponse {
  usd: number;
  priced_by: PricedBy;
  ledgerId: number;
}

/** What `submitBatch` did: the batch the run now waits for. */
export interface BatchSubmitResult {
  batchId: string;
  /** True when the run already had this batch in flight (a restart before it was parked). */
  reused: boolean;
}

/** A batch's result as the resumed run sees it (`batchResult`). */
export type BatchCallResult =
  | { status: 'succeeded'; result: LlmCallResult }
  | {
      status: 'errored' | 'expired' | 'canceled';
      error: string;
      retryable: boolean;
    };

/**
 * A turn an ACP agent ran on its own model (ARCHITECTURE §5.4): the core only sees what the
 * agent reported. `provider` is the connector's name; `usage.reportedUsd` is the agent's
 * cumulative cost when it sends one, else the tokens are priced from the table for `model`.
 */
export interface AgentTurn {
  provider: string;
  model: string;
  usage: LlmUsage;
  /** The run's cap (the smaller of the task's and the action's `budget.max_usd`), if any. */
  maxUsd?: number | undefined;
}

export interface AgentTurnResult {
  usd: number;
  priced_by: PricedBy;
  ledgerId: number;
}

/**
 * `ctx.llm`: the only way an action reaches a model. It prices, budgets and ledgers every
 * call (CLAUDE.md: never an unbudgeted call), so runners never touch the store.
 */
export interface LlmPort {
  readonly defaults: LlmDefaultsConfig;
  readonly decideDefaults: DecideDefaultsConfig;
  /** Names of the configured providers. */
  providers(): string[];
  /** Contents of a `system_file` (relative to the agent.yaml directory); `NonRetryableError` when unreadable. */
  readSystemFile(relative: string): string;
  /** Throws `BudgetExceededError`, `ProviderUnavailableError` or `UnpricedModelError` (all non-retryable). */
  call(req: LlmCall, ctx: LlmCallContext): Promise<LlmCallResult>;
  /**
   * One Decisions API call, budgeted and ledgered like `call`. Also `ProviderUnavailableError`
   * when the provider's type does not serve the Decisions API.
   */
  decide(req: DecideCall, ctx: LlmCallContext): Promise<DecideCallResult>;
  /**
   * `batch: true` (ARCHITECTURE §5.2): the same checks as `call` with the worst case at the
   * batch price, then one request submitted to the provider's Message Batches API. Nothing
   * is ledgered yet: the service polls the batch and, once it ended, writes the row and
   * publishes `llm.batch.ended` with the result. A run that already has a batch in flight
   * gets that one back. Also `ProviderUnavailableError` when the provider's type has no
   * batch API.
   */
  submitBatch(req: LlmCall, ctx: LlmCallContext): Promise<BatchSubmitResult>;
  /**
   * Reads an `llm.batch.ended` payload for the run that waited for it; for a succeeded
   * batch, the post-hoc checks of `call` (`UnpricedModelError`, `BudgetExceededError`).
   * A payload of another shape is a `NonRetryableError`.
   */
  batchResult(
    payload: JsonValue,
    req: { maxUsd?: number | undefined },
    ctx: LlmCallContext,
  ): BatchCallResult;
  /**
   * Before an agent turn: throws `BudgetExceededError` when the daily cap is reached or the
   * run has already spent its `maxUsd`. No provider is contacted.
   */
  checkBudget(req: { maxUsd?: number | undefined }, ctx: LlmCallContext): void;
  /**
   * After an agent turn: the ledger row for what the agent reported, the breaker, and the
   * post-hoc checks (`UnpricedModelError` when nothing prices it, `BudgetExceededError` when
   * the run is now over `maxUsd`; the row stays either way).
   */
  record(turn: AgentTurn, ctx: LlmCallContext): AgentTurnResult;
}
