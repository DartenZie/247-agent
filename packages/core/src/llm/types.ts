import type { Logger } from '../log.js';
import type { PricedBy } from '../store/ledger.js';
import type { JsonValue, RunRecord } from '../store/types.js';
import type { Effort, LlmDefaultsConfig, ProviderType } from './config.js';

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

/** One provider adapter, built per call from the resolved config. */
export interface LlmProvider {
  readonly name: string;
  readonly type: ProviderType;
  complete(req: LlmRequest): Promise<LlmResponse>;
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

/**
 * `ctx.llm`: the only way an action reaches a model. It prices, budgets and ledgers every
 * call (CLAUDE.md: never an unbudgeted call), so runners never touch the store.
 */
export interface LlmPort {
  readonly defaults: LlmDefaultsConfig;
  /** Names of the configured providers. */
  providers(): string[];
  /** Contents of a `system_file` (relative to the agent.yaml directory); `NonRetryableError` when unreadable. */
  readSystemFile(relative: string): string;
  /** Throws `BudgetExceededError`, `ProviderUnavailableError` or `UnpricedModelError` (all non-retryable). */
  call(req: LlmCall, ctx: LlmCallContext): Promise<LlmCallResult>;
}
