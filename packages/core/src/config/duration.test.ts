import { describe, expect, it } from 'vitest';

import { parseDuration } from './duration.js';

describe('parseDuration', () => {
  it('converts every unit to milliseconds', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '30', '30 s', '1.5h', '-1s', 'm']) {
      expect(() => parseDuration(bad)).toThrow(/invalid duration/);
    }
  });
});
