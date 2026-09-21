import type { PricingConfig } from './config.js';
import type { LlmUsage } from './types.js';

/** USD per million tokens, every component known. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** OpenAI bills cache writes at the plain input price; only reads are discounted. */
function openai(input: number, cache_read: number, output: number): ModelPrice {
  return { input, output, cache_read, cache_write: input };
}

/**
 * Published prices, USD per Mtok. Anthropic (platform.claude.com/docs/en/about-claude/
 * pricing): cache write 1.25x and cache read 0.1x the input price. OpenAI (developers.
 * openai.com/api/docs/pricing, checked 2026-09-20): the standard tier; the long-context
 * surcharge above 272K input tokens is not modelled. TypeSafe's Jev (openrouter.ai/typesafe,
 * checked 2026-09-21): input only, output free; listed so the worst-case check before a
 * `decide` call has a number, the reported cost still wins after it. Extend or override with
 * `pricing:` in agent.yaml. Other OpenRouter models need no entry: the provider reports each
 * call's cost.
 */
export const BUILTIN_PRICES: Readonly<Record<string, ModelPrice>> = {
  'typesafe/jev-1.13': { input: 0.042, output: 0, cache_read: 0.042, cache_write: 0.042 },
  '~typesafe/jev-latest': { input: 0.042, output: 0, cache_read: 0.042, cache_write: 0.042 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'gpt-6-astra': openai(10, 1, 50),
  'gpt-5.6-terra': openai(2, 0.2, 12),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2),
  'gpt-5.5': openai(5, 0.5, 30),
  'gpt-5.4': openai(2.5, 0.25, 15),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
};

export type PricingTable = ReadonlyMap<string, ModelPrice>;

export class PricingError extends Error {
  constructor(
    readonly model: string,
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Merges `pricing:` overrides field by field over the built-in table. A model the table
 * does not know needs `input` and `output`; a missing cache price falls back to `input`.
 */
export function resolvePricing(overrides: PricingConfig): PricingTable {
  const out = new Map<string, ModelPrice>(Object.entries(BUILTIN_PRICES));
  for (const [model, partial] of Object.entries(overrides)) {
    const base = out.get(model);
    const input = partial.input ?? base?.input;
    const output = partial.output ?? base?.output;
    if (input === undefined || output === undefined) {
      throw new PricingError(
        model,
        `pricing.${model}: "input" and "output" are required for a model the built-in table does not know`,
      );
    }
    out.set(model, {
      input,
      output,
      cache_read: partial.cache_read ?? base?.cache_read ?? input,
      cache_write: partial.cache_write ?? base?.cache_write ?? input,
    });
  }
  return out;
}

export function costUsd(price: ModelPrice, usage: LlmUsage): number {
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cache_read +
      usage.cacheWrite * price.cache_write) /
    1e6
  );
}

/** Deliberately pessimistic (3 chars per token) so the worst-case budget check never under-counts. */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** `YYYY-MM-DD` of the UTC day; the daily budget window (ARCHITECTURE §9). */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO timestamp of the UTC midnight starting `d`'s day. */
export function startOfUtcDay(d: Date): string {
  return `${utcDay(d)}T00:00:00.000Z`;
}
