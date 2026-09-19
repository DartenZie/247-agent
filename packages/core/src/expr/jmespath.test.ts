import { describe, expect, it } from 'vitest';

import { compileFilter, FilterSyntaxError, isJmesTruthy, validateJmespath } from './jmespath.js';

describe('isJmesTruthy', () => {
  it('follows JMESPath rules', () => {
    for (const falsy of [null, undefined, false, '', [], {}]) {
      expect(isJmesTruthy(falsy)).toBe(false);
    }
    for (const truthy of [0, 1, 'a', [0], { a: null }, true]) {
      expect(isJmesTruthy(truthy)).toBe(true);
    }
  });
});

describe('compileFilter', () => {
  it('rejects bad syntax at compile time', () => {
    expect(() => compileFilter('payload.from ==')).toThrow(FilterSyntaxError);
    expect(validateJmespath('payload.from ==')).toMatch(/Invalid token/);
    expect(validateJmespath('payload.from')).toBeNull();
  });

  it('evaluates against the whole document', () => {
    const f = compileFilter("payload.from == 'orchestrator@example.cz'");
    expect(f.evaluate({ payload: { from: 'orchestrator@example.cz' } })).toBe(true);
    expect(f.evaluate({ payload: { from: 'other@example.cz' } })).toBe(false);
    expect(f.evaluate({})).toBe(false);
  });

  it('applies truthiness to the result', () => {
    expect(compileFilter('payload.items').evaluate({ payload: { items: [] } })).toBe(false);
    expect(compileFilter('payload.count').evaluate({ payload: { count: 0 } })).toBe(true);
  });

  it('propagates runtime errors to the caller', () => {
    expect(() => compileFilter('sum(payload)').evaluate({ payload: 'x' })).toThrow();
  });
});
