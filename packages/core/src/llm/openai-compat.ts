import OpenAI from 'openai';

import { NonRetryableError } from '../actions/types.js';
import type { JsonValue } from '../store/types.js';
import type { LlmUsage, ResolvedProvider } from './types.js';

type ClientOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;
export type FetchLike = NonNullable<ClientOptions['fetch']>;

/** Options shared by the two adapters built on the `openai` SDK (OpenAI, OpenRouter). */
export interface OpenAiCompatOptions {
  /** Replaces the HTTP transport (tests); never used by the daemon. */
  fetch?: FetchLike | undefined;
}

/**
 * Replaces the SDK's 10-minute default so the run's own `timeout`, which aborts `signal`,
 * is the only real bound on a call.
 */
export const HTTP_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * One SDK client per call: no SDK retries (whether to try again is the task's `retry`
 * policy), the base URL always explicit so an `OPENAI_BASE_URL` in the daemon's
 * environment can never redirect a call, the key in `Authorization: Bearer` only.
 */
export function createClient(
  provider: ResolvedProvider,
  defaultBaseUrl: string,
  opts: OpenAiCompatOptions,
): OpenAI {
  return new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl ?? defaultBaseUrl,
    defaultHeaders: provider.headers,
    maxRetries: 0,
    timeout: HTTP_TIMEOUT_MS,
    fetch: opts.fetch,
  });
}

/** Token counts as the OpenAI-style APIs report them: cache hits and writes inside the input total. */
export interface RawUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

/**
 * The ledger wants `input` to be only what is billed at the full input price, so the cached
 * and cache-written tokens (both counted inside `input_tokens` / `prompt_tokens`) move to
 * their own columns.
 */
export function normaliseUsage(u: RawUsage): LlmUsage {
  return {
    input: Math.max(0, u.input - u.cached - u.cacheWrite),
    output: u.output,
    cacheRead: u.cached,
    cacheWrite: u.cacheWrite,
  };
}

/**
 * The cache counters of a `*_tokens_details` block. Typed as always present by the SDK
 * for the Responses API, but older responses and some OpenRouter upstreams omit the block
 * or its fields, so the parameter type is deliberately wider than the SDK's.
 */
export function cacheTokensOf(
  details:
    { cached_tokens?: number | undefined; cache_write_tokens?: number | undefined } | undefined,
): { cached: number; cacheWrite: number } {
  return { cached: details?.cached_tokens ?? 0, cacheWrite: details?.cache_write_tokens ?? 0 };
}

/** A structured output that is not JSON fails retryably: the next attempt may do better. */
export function parseStructured(prefix: string, text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${prefix}: failed to parse the structured output as JSON: ${why}`, {
      cause: err,
    });
  }
}

/**
 * 4xx client errors are the config's fault (`NonRetryableError`); 429, 5xx and transport
 * failures are the task's `retry` policy's business (plain `Error`); an abort (`signal`) is
 * rethrown untouched for the executor to classify. Never puts the key in a message: the
 * status, the API's error code and its own text only.
 */
export function mapError(prefix: string, err: unknown): Error {
  if (err instanceof OpenAI.APIUserAbortError) {
    return err;
  }
  if (
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError ||
    err instanceof OpenAI.NotFoundError ||
    err instanceof OpenAI.BadRequestError ||
    err instanceof OpenAI.UnprocessableEntityError
  ) {
    return new NonRetryableError(describe(prefix, err), { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    return new Error(describe(prefix, err), { cause: err });
  }
  if (err instanceof OpenAI.OpenAIError) {
    return new Error(`${prefix}: ${err.message}`, { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * `openai: 401 invalid_api_key: Incorrect API key provided` rather than the raw body. The
 * SDK stores the body's inner `error` object; OpenAI puts a string `code` (or `type`)
 * there, OpenRouter a numeric `code` equal to the status, which adds nothing.
 */
function describe(
  prefix: string,
  err: { status?: number | undefined; error?: unknown; message: string },
): string {
  const body = err.error as { message?: unknown; code?: unknown; type?: unknown } | undefined;
  const message = body?.message;
  if (typeof message !== 'string') {
    return `${prefix}: ${err.message}`;
  }
  const status = err.status === undefined ? '' : `${String(err.status)} `;
  const kind =
    typeof body?.code === 'string' && body.code !== ''
      ? `${body.code}: `
      : typeof body?.type === 'string'
        ? `${body.type}: `
        : '';
  return `${prefix}: ${status}${kind}${message}`;
}
