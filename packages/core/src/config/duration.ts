import { z } from 'zod';

/** Durations in config look like `500ms`, `30s`, `15m`, `24h`, `7d`. */
export const DURATION = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses a config duration into milliseconds. Throws on anything the schema would reject. */
export function parseDuration(text: string): number {
  const m = DURATION.exec(text);
  if (m === null) {
    throw new Error(`invalid duration "${text}" (expected e.g. 30s, 15m, 24h)`);
  }
  return Number(m[1]) * (UNIT_MS[m[2] ?? ''] ?? NaN);
}

/** The longest delay `setTimeout`/`setInterval` accept (2^31 - 1 ms, about 24.8 days). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A config duration that arms a timer. Node fires a longer delay after 1 ms, so the schema
 * caps it; `zero: false` also rejects `0s` for a timeout, which would fire at once.
 */
export function timerDuration(opts: { hint: string; zero: boolean }): z.ZodString {
  const min = opts.zero ? 0 : 1;
  return z
    .string()
    .regex(DURATION, opts.hint)
    .refine(
      (d) => !DURATION.test(d) || (parseDuration(d) >= min && parseDuration(d) <= MAX_TIMER_MS),
      opts.zero
        ? 'must be at most 24d (the longest a timer can wait)'
        : 'must be between 1ms and 24d (the longest a timer can wait)',
    );
}
