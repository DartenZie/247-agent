import { describe, expect, it } from 'vitest';

import {
  compileFilter,
  FilterSyntaxError,
  isJmesTruthy,
  lintJmespath,
  parseJmespath,
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
  it('suggests backticks for a bare number, quoting it as written', () => {
    expect(validateJmespath('payload.amount > 100')).toMatch(
      /Invalid token \(Number\): "100"; a number literal needs backticks, as in `100`$/,
    );
    // The lexer keeps only the integer part; the hint quotes the source text.
    expect(validateJmespath('payload.amount > 100.5')).toMatch(/as in `100\.5`$/);
    expect(validateJmespath('payload.n > 1e3')).toMatch(/as in `1e3`$/);
    expect(validateJmespath('payload.n > -2.5e-3')).toMatch(/as in `-2\.5e-3`$/);
    expect(() => compileFilter('payload.n == -1')).toThrow(/as in `-1`$/);
    // An index before the bad number is not the bad number.
    expect(validateJmespath('items[0].n > 7')).toMatch(/as in `7`$/);
    // Not a JSON number as written: the hint names no number.
    expect(validateJmespath('payload.n > 01')).toMatch(/a number literal needs backticks$/);
    expect(validateJmespath('payload.from ==')).not.toMatch(/backticks/);
  });

  it('parses each expression once, sharing the result with the lint', () => {
    expect(parseJmespath('payload.x == true')).toBe(parseJmespath('payload.x == true'));
    expect(parseJmespath('payload.x ==')).toBe(parseJmespath('payload.x =='));
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
  });

  it('offers the string for a double-quoted "true", "null" or number, a field too', () => {
    expect(lintJmespath('payload.ok == "true"')).toEqual([
      'payload.ok == "true": "true" in double quotes is a field named "true", not a string; write \'true\' for the string, or `true` for the boolean',
    ]);
    expect(lintJmespath('payload.v != "null"')).toEqual([
      'payload.v != "null": "null" in double quotes is a field named "null", not a string; write \'null\' for the string, or `null` for null',
    ]);
    expect(lintJmespath('payload.n == "5"')).toEqual([
      'payload.n == "5": "5" in double quotes is a field named "5", not a string; write \'5\' for the string, or `5` for the number',
    ]);
    // Any other quoted identifier may well be a field with an awkward name.
    expect(lintJmespath('payload."content-type" == \'text/plain\'')).toEqual([]);
  });

  it('flags an ordering comparison with a quoted number, on either side', () => {
    expect(lintJmespath("payload.amount > '100'")).toEqual([
      "payload.amount > '100': '100' is a string and JMESPath orders only numbers; write `100`",
    ]);
  });

  it('echoes operands as written: backtick JSON, raw strings with their escapes', () => {
    expect(lintJmespath('`"2.5"` <= steps[0].payload.score')).toEqual([
      '`"2.5"` <= steps[0].payload.score: `"2.5"` is a string and JMESPath orders only numbers; write `2.5`',
    ]);
    expect(lintJmespath("'it\\'s' != false")).toEqual([
      "'it\\'s' != false: false here is a field named \"false\", not the literal; write `false`",
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

  it('walks every node that holds a sub-expression', () => {
    const flagged = (expr: string): number => lintJmespath(expr).length;
    expect(flagged('{ok: payload.approved == true}')).toBe(1); // MultiSelectHash value
    expect(flagged('payload.{ok: approved == true, n: n}')).toBe(1);
    expect(flagged('[payload.a == true, payload.b == false]')).toBe(2); // MultiSelectList
    expect(flagged('payload.[a == null]')).toBe(1);
    expect(flagged('payload.items[?done == true].id')).toBe(1); // FilterProjection condition
    expect(flagged('payload.items[*].a[?b == true]')).toBe(1); // Projection right side
    expect(flagged('payload.*.a[?b == true]')).toBe(1); // ValueProjection
    expect(flagged('payload.items[][?b == true]')).toBe(1); // Flatten
    expect(flagged('payload | ok == true')).toBe(1); // Pipe
    expect(flagged('sort_by(payload.items, &(done == true))')).toBe(1); // ExpressionReference
    expect(flagged('!(payload.ok == false)')).toBe(1); // NotExpression
    expect(flagged('payload.a || payload.b == null')).toBe(1); // OrExpression
    // A backtick literal shaped like an AST node is data, not an expression.
    expect(flagged('payload.x == `{"type": "Field", "name": "true"}`')).toBe(0);
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

  it('names a placeholder left as an operand by its template', () => {
    const placeholders = new Map([['__oa_tpl_0__', '${event.payload.want}']]);
    expect(lintJmespath('payload.ok == __oa_tpl_0__', { placeholders })).toEqual([
      "payload.ok == ${event.payload.want}: ${event.payload.want} is rendered into the filter as plain text, so a string or true/false/null becomes a field name and a number breaks the filter; write '${event.payload.want}' for a string or `${event.payload.want}` for a number or boolean",
    ]);
    expect(lintJmespath("payload.ok == '__oa_tpl_0__'", { placeholders })).toEqual([]);
  });
});
