import { describe, expect, it } from 'vitest';

import { toJson } from './json.js';
import type { JsonValue } from './store/types.js';

interface WithOptional {
  id: string;
  note?: string;
  tags: readonly string[];
  nested: { at: number | null; flag?: boolean };
}

describe('toJson', () => {
  it('returns the value it is given', () => {
    const rec: WithOptional = { id: 'a', tags: ['x'], nested: { at: null } };
    const out: JsonValue = toJson(rec);
    expect(out).toBe(rec);
    expect(toJson([1, 'two', null, true])).toEqual([1, 'two', null, true]);
  });

  it('accepts records with optional fields, which plain JsonValue does not', () => {
    const rec: WithOptional = { id: 'a', note: 'n', tags: [], nested: { at: 1, flag: true } };
    // @ts-expect-error optional fields are not assignable to JsonValue under exactOptionalPropertyTypes
    const direct: JsonValue = rec;
    expect(toJson(rec)).toEqual(direct);
  });

  it('rejects values that JSON cannot represent at compile time', () => {
    // These lines are type checks: `tsc -b` fails when an error below goes away.
    const bad = (): void => {
      // @ts-expect-error a Date serializes to a string, not to itself
      toJson({ at: new Date() });
      // @ts-expect-error JSON.stringify throws on a bigint
      toJson({ n: 1n });
      // @ts-expect-error a Map serializes to {}
      toJson({ m: new Map<string, number>() });
      // @ts-expect-error a Set serializes to {}
      toJson([new Set<number>()]);
      // @ts-expect-error a function is dropped
      toJson({ f: () => 1 });
      // @ts-expect-error undefined is not a JSON value
      toJson(undefined);
      // @ts-expect-error unknown may be anything
      toJson({ x: 1 as unknown });
    };
    expect(typeof bad).toBe('function');
  });
});
