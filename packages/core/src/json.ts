/**
 * Typed conversion to `JsonValue`. A record with optional fields is not assignable to
 * `JsonValue` under `exactOptionalPropertyTypes`, so callers would otherwise cast through
 * `unknown` and lose the check that the value serializes. `toJson` keeps that check: a
 * `Date`, `bigint`, `Map`, `Set`, function, `undefined` or `unknown` anywhere in the value
 * is a compile error. The same helper is in `@247-agent/connector-sdk` for connectors.
 */
import type { JsonValue } from './store/types.js';

/**
 * `T` when every part of it is JSON: primitives, arrays and plain objects whose fields
 * are JSON or absent. Anything else maps to `never`, which `toJson`'s argument rejects.
 */
export type JsonCompatible<T> = unknown extends T
  ? never
  : [JsonValue] extends [T] // a field typed `JsonValue` itself; stops the recursion
    ? [T] extends [JsonValue]
      ? T
      : never // wider than JSON, such as `JsonValue | Date`
    : CompatibleParts<T>;

/** Distributes over a union, so each member is checked on its own. */
type CompatibleParts<T> = T extends null | boolean | number | string
  ? T
  : [keyof T] extends [never]
    ? never // `{}` and `object`: a Date or a Map hides behind them
    : T extends readonly unknown[]
      ? { [K in keyof T]: JsonCompatible<T[K]> }
      : T extends Date | Map<unknown, unknown> | Set<unknown> | ((...args: never[]) => unknown)
        ? never
        : T extends object
          ? { [K in keyof T]: JsonCompatible<Exclude<T[K], undefined>> | Absent<T, K> }
          : never;

/**
 * `undefined` where `JSON.stringify` drops the field: an optional field, or the value of an
 * index signature (`Partial<Record<string, number>>`). A required field stays required.
 */
type Absent<T, K extends keyof T> = string extends K
  ? undefined
  : number extends K
    ? undefined
    : object extends Pick<T, K>
      ? undefined
      : never;

/** `value` typed as `JsonValue`; compiles only when it is JSON-serializable as it stands. */
export function toJson<T>(value: T & JsonCompatible<T>): JsonValue {
  return value as JsonValue;
}
