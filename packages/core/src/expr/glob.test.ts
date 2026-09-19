import { describe, expect, it } from 'vitest';

import { compileTypePattern, isTypePattern, validateTypePattern } from './glob.js';

describe('compileTypePattern', () => {
  it('matches exactly one segment per wildcard', () => {
    const m = compileTypePattern('task.*.failed');
    expect(m('task.notify.failed')).toBe(true);
    expect(m('task.a.b.failed')).toBe(false);
    expect(m('task.failed')).toBe(false);
    expect(m('task..failed')).toBe(false);
    expect(m('xtask.notify.failed')).toBe(false);
  });

  it('compares exact patterns literally', () => {
    const m = compileTypePattern('email.received');
    expect(m('email.received')).toBe(true);
    expect(m('email.receivedx')).toBe(false);
    expect(m('emailXreceived')).toBe(false);
  });

  it('reports whether a string is a pattern', () => {
    expect(isTypePattern('a.*')).toBe(true);
    expect(isTypePattern('a.b')).toBe(false);
  });
});

describe('validateTypePattern', () => {
  const allow = { allowWildcard: true };
  const deny = { allowWildcard: false };

  it('accepts valid patterns', () => {
    expect(validateTypePattern('task.*.failed', allow)).toBeNull();
    expect(validateTypePattern('budget.exceeded', deny)).toBeNull();
    expect(validateTypePattern('a-b_c.d1', deny)).toBeNull();
  });

  it('rejects partial wildcards, double stars, bad characters and wildcards in event types', () => {
    expect(validateTypePattern('task.fail*', allow)).toMatch(/invalid segment/);
    expect(validateTypePattern('task.**', allow)).toMatch(/invalid segment/);
    expect(validateTypePattern('Task.failed', allow)).toMatch(/invalid segment/);
    expect(validateTypePattern('task..failed', allow)).toMatch(/invalid segment/);
    expect(validateTypePattern('task.*.failed', deny)).toMatch(/wildcards are not allowed/);
    expect(validateTypePattern('a.b.c.d.e.f.g.h.i', allow)).toMatch(/too many segments/);
  });
});
