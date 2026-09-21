import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PRICES,
  costUsd,
  estimateInputTokens,
  PricingError,
  resolvePricing,
  startOfUtcDay,
  utcDay,
} from './pricing.js';

describe('resolvePricing', () => {
  it('starts from the built-in table and merges overrides field by field', () => {
    const t = resolvePricing({ 'claude-sonnet-5': { output: 12 } });
    expect(t.get('claude-sonnet-5')).toEqual({ ...BUILTIN_PRICES['claude-sonnet-5'], output: 12 });
    expect(t.get('claude-haiku-4-5')).toEqual(BUILTIN_PRICES['claude-haiku-4-5']);
  });

  it('needs input and output for an unknown model and defaults cache prices to input', () => {
    expect(() => resolvePricing({ 'gpt-x': { output: 2 } })).toThrow(PricingError);
    expect(resolvePricing({ 'gpt-x': { input: 0.5, output: 2 } }).get('gpt-x')).toEqual({
      input: 0.5,
      output: 2,
      cache_read: 0.5,
      cache_write: 0.5,
    });
  });

  it('knows TypeSafe Jev, input only', () => {
    const t = resolvePricing({});
    const jev = t.get('typesafe/jev-1.13');
    if (jev === undefined) {
      throw new Error('unreachable');
    }
    expect(jev).toEqual({ input: 0.042, output: 0, cache_read: 0.042, cache_write: 0.042 });
    expect(t.get('~typesafe/jev-latest')).toEqual(jev);
    expect(
      costUsd(jev, {
        input: 1000,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBeCloseTo(0.000042, 9);
  });
});

describe('costUsd and helpers', () => {
  it('prices each component per million tokens', () => {
    const price = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
    expect(
      costUsd(price, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBeCloseTo(1);
    expect(
      costUsd(price, { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 2000 }),
    ).toBeCloseTo(0.001 + 0.0005 + 0.001 + 0.0025);
  });

  it('estimates pessimistically and cuts days at UTC midnight', () => {
    expect(estimateInputTokens('')).toBe(0);
    expect(estimateInputTokens('abcd')).toBe(2);
    const d = new Date('2026-09-19T23:59:59.999Z');
    expect(utcDay(d)).toBe('2026-09-19');
    expect(startOfUtcDay(d)).toBe('2026-09-19T00:00:00.000Z');
  });
});
