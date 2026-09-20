import type { PricingConfig } from './config.js';
import type { LlmUsage } from './types.js';

/** USD per million tokens, every component known. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * Anthropic's published prices (platform.claude.com/docs/en/about-claude/pricing): cache
 * write 1.25x and cache read 0.1x the input price. Extend or override with `pricing:` in
 * agent.yaml; other providers' models arrive with their adapters.
 */
export const BUILTIN_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
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
