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
