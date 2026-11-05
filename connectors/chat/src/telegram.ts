/**
 * A thin Bot API client over `fetch`: one POST per method, JSON in and out. Errors never
 * carry the token (it is only in the URL) and expose Telegram's `error_code` and
 * `retry_after` so the poll loop can back off.
 */

import {
  createJsonClient,
  HttpTransportError,
  isTransientHttpError,
  type FetchLike,
  type JsonResponse,
} from '@247-agent/connector-sdk';

export interface TelegramApi {
  call<T>(method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
}

export interface CallOptions {
  /** Overrides the client's default timeout for this call (long polls need a longer one). */
  timeoutMs?: number;
}

export class TelegramError extends Error {
  /** Telegram's `error_code` (an HTTP status), or 0 for a transport failure. */
  readonly code: number;
  /** Seconds to wait, from a 429's `parameters.retry_after`. */
  readonly retryAfter: number | undefined;
  /**
   * Worth retrying (`isTransientHttpError`). Every method is a POST; only the `get…` ones
   * are idempotent, so a `sendMessage` that timed out or got a 502 is not retried.
   */
  readonly transient: boolean;
  constructor(
    method: string,
    code: number,
    description: string,
    retryAfter?: number,
    cause?: unknown,
  ) {
    super(`${method}: ${description}${code > 0 ? ` (${String(code)})` : ''}`);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.transient = isTransientHttpError({
      status: code,
      idempotent: method.startsWith('get'),
      cause,
    });
  }
}

export type { FetchLike };

export interface TelegramClientOptions {
  token: string;
  apiBase: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

interface ApiEnvelope {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export function createTelegramApi(opts: TelegramClientOptions): TelegramApi {
  const http = createJsonClient({
    secrets: [opts.token],
    placeholder: '<token>',
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });

  return {
    async call<T>(method: string, params: Record<string, unknown> = {}, callOpts?: CallOptions) {
      let res: JsonResponse;
      try {
        res = await http.request({
          method: 'POST',
          url: `${opts.apiBase}/bot${opts.token}/${method}`,
          body: params,
          timeoutMs: callOpts?.timeoutMs ?? opts.timeoutMs,
        });
      } catch (err) {
        throw err instanceof HttpTransportError
          ? new TelegramError(method, 0, err.message, undefined, err)
          : err;
      }
      if (typeof res.body !== 'object' || res.body === null) {
        throw new TelegramError(
          method,
          res.status,
          `non-JSON response (HTTP ${String(res.status)})`,
        );
      }
      const body = res.body as ApiEnvelope;
      if (!body.ok) {
        throw new TelegramError(
          method,
          body.error_code ?? res.status,
          http.redact(body.description ?? 'request failed'),
          body.parameters?.retry_after,
        );
      }
      return body.result as T;
    },
  };
}
