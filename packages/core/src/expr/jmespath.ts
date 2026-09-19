import { compile, search } from 'jmespath';

/** A compiled trigger filter. `evaluate` may throw on runtime type errors. */
export interface Filter {
  readonly expr: string;
  evaluate(data: unknown): boolean;
}

export class FilterSyntaxError extends Error {
  constructor(
    readonly expr: string,
    cause: unknown,
  ) {
    super(`invalid JMESPath "${expr}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'FilterSyntaxError';
  }
}

/**
 * JMESPath truthiness: `null`, `false`, empty string, empty array and empty object are
 * false; everything else, including `0`, is true.
 */
export function isJmesTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') {
    return false;
  }
  if (Array.isArray(v)) {
    return v.length > 0;
  }
  if (typeof v === 'object') {
    return Object.keys(v).length > 0;
  }
  return true;
}

/** Returns an error message, or null when `expr` parses. */
export function validateJmespath(expr: string): string | null {
  try {
    compile(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Parses once to fail fast on syntax errors. Evaluation re-parses via `search` because the
 * `jmespath` package exposes no interpreter over a pre-built AST; expressions are short.
 */
export function compileFilter(expr: string): Filter {
  try {
    compile(expr);
  } catch (err) {
    throw new FilterSyntaxError(expr, err);
  }
  return {
    expr,
    evaluate: (data) => isJmesTruthy(search(data, expr)),
  };
}
