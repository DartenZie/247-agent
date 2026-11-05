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
  : T extends JsonValue
    ? T
    : T extends readonly unknown[]
      ? { [K in keyof T]: JsonCompatible<T[K]> }
      : T extends Date | Map<unknown, unknown> | Set<unknown> | ((...args: never[]) => unknown)
        ? never
        : T extends object
          ? { [K in keyof T]: JsonCompatible<Exclude<T[K], undefined>> | OptionalOf<T, K> }
          : never;

/** `undefined` for an optional field, so `{ a?: string }` stays compatible. */
type OptionalOf<T, K extends keyof T> = object extends Pick<T, K> ? undefined : never;

/** `value` typed as `JsonValue`; compiles only when it is JSON-serializable as it stands. */
export function toJson<T>(value: T & JsonCompatible<T>): JsonValue {
  return value as JsonValue;
}
