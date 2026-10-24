/**
 * A thin Bot API client over `fetch`: one POST per method, JSON in and out. Errors never
 * carry the token (it is only in the URL) and expose Telegram's `error_code` and
 * `retry_after` so the poll loop can back off.
 */

import { isTransientHttpError } from '@247-agent/connector-sdk';

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

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

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
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const token = opts.token;
  const hideToken = (text: string): string => text.split(token).join('<token>');

  return {
    async call<T>(method: string, params: Record<string, unknown> = {}, callOpts?: CallOptions) {
      const url = `${opts.apiBase}/bot${token}/${method}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(callOpts?.timeoutMs ?? opts.timeoutMs),
        });
      } catch (err) {
        const cause = err instanceof Error ? (err.cause ?? err) : err;
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new TelegramError(method, 0, hideToken(message), undefined, err);
      }
      let body: ApiEnvelope;
      try {
        body = (await res.json()) as ApiEnvelope;
      } catch {
        throw new TelegramError(
          method,
          res.status,
          `non-JSON response (HTTP ${String(res.status)})`,
        );
      }
      if (!body.ok) {
        throw new TelegramError(
          method,
          body.error_code ?? res.status,
          hideToken(body.description ?? 'request failed'),
          body.parameters?.retry_after,
        );
      }
      return body.result as T;
    },
  };
}
