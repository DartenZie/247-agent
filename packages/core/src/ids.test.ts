import { describe, expect, it } from 'vitest';

import { newId } from './ids.js';

describe('newId', () => {
  it('uses the prefix and a 26 char body', () => {
    const id = newId('evt');
    expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId('run')).toMatch(/^run_/);
    expect(newId('cor')).toMatch(/^cor_/);
  });

  it('sorts lexically by time', () => {
    const a = newId('evt', new Date('2026-01-01T00:00:00.000Z'));
    const b = newId('evt', new Date('2026-01-01T00:00:00.001Z'));
    const c = newId('evt', new Date('2027-01-01T00:00:00.000Z'));
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('is unique', () => {
    const now = new Date();
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(newId('evt', now));
    }
    expect(ids.size).toBe(10_000);
  });
});
