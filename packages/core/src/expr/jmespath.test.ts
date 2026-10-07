import { describe, expect, it } from 'vitest';

import {
  compileFilter,
  FilterSyntaxError,
  isJmesTruthy,
  lintJmespath,
  validateJmespath,
} from './jmespath.js';

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
    const f = compileFilter("payload.from == 'editor@example.com'");
    expect(f.evaluate({ payload: { from: 'editor@example.com' } })).toBe(true);
    expect(f.evaluate({ payload: { from: 'other@example.com' } })).toBe(false);
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

describe('validateJmespath', () => {
  it('suggests backticks for a bare number', () => {
    expect(validateJmespath('payload.amount > 100')).toMatch(
      /Invalid token \(Number\): "100"; a number literal needs backticks, as in `100`/,
    );
    expect(() => compileFilter('payload.n == -1')).toThrow(/as in `-1`/);
    expect(validateJmespath('payload.from ==')).not.toMatch(/backticks/);
  });
});

describe('lintJmespath', () => {
  it('flags a bare true, false or null, which JMESPath reads as a field', () => {
    expect(lintJmespath('payload.approved == true')).toEqual([
      'payload.approved == true: true here is a field named "true", not the literal; write `true`',
    ]);
    expect(lintJmespath('false != payload.done')).toEqual([
      'false != payload.done: false here is a field named "false", not the literal; write `false`',
    ]);
    expect(lintJmespath('items[?done == null]')).toHaveLength(1);
    // A double-quoted identifier is a field too.
    expect(lintJmespath('payload.ok == "true"')).toHaveLength(1);
  });

  it('flags an ordering comparison with a quoted number, on either side', () => {
    expect(lintJmespath("payload.amount > '100'")).toEqual([
      "payload.amount > '100': '100' is a string and JMESPath orders only numbers; write `100`",
    ]);
    expect(lintJmespath('`"2.5"` <= steps[0].payload.score')).toEqual([
      "'2.5' <= steps[0].payload.score: '2.5' is a string and JMESPath orders only numbers; write `2.5`",
    ]);
  });

  it('finds comparisons nested in boolean expressions and function arguments', () => {
    expect(
      lintJmespath("!(payload.a == null) && (length(payload.items) >= '3' || payload.b)"),
    ).toEqual([
      'payload.a == null: null here is a field named "null", not the literal; write `null`',
      "length(payload.items) >= '3': '3' is a string and JMESPath orders only numbers; write `3`",
    ]);
  });

  it('leaves correct comparisons, string equality and unparseable input alone', () => {
    for (const ok of [
      'payload.approved == `true`',
      'payload.amount > `100`',
      "payload.zip == '01234'",
      "payload.date > '2026-01-01'",
      'payload.true_flag == `false`',
      'payload.nested.true',
      'payload.from ==',
    ]) {
      expect(lintJmespath(ok), ok).toEqual([]);
    }
  });
});
