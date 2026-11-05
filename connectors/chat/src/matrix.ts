/**
 * A thin Matrix Client-Server API client over `fetch` (spec v1.x, `/_matrix/client/v3`):
 * JSON in and out, the access token only in the `Authorization` header. Errors expose
 * the HTTP status, Matrix's `errcode` and a rate limit's wait so the sync loop can back off.
 */
import {
  createJsonClient,
  HttpTransportError,
  isTransientHttpError,
  type FetchLike,
  type JsonResponse,
} from '@247-agent/connector-sdk';

export type { FetchLike };

export interface MatrixCallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Overrides the client's default timeout for this call (long polls need a longer one). */
  timeoutMs?: number;
}

export interface MatrixApi {
  /** `path` is relative to `/_matrix/client/v3` and must already be URL-encoded. */
  call<T>(method: string, path: string, opts?: MatrixCallOptions): Promise<T>;
}

export class MatrixError extends Error {
  /** HTTP status, or 0 for a transport failure. */
  readonly status: number;
  /** Matrix's `errcode` (`M_FORBIDDEN`, `M_LIMIT_EXCEEDED`, …), when the server sent one. */
  readonly errcode: string | undefined;
  /** Milliseconds to wait, from a 429. */
  readonly retryAfterMs: number | undefined;
  /**
   * Worth retrying (`isTransientHttpError`). Only a GET is idempotent: a send carries a
   * fresh transaction id per call, so the homeserver would not drop a repeat.
   */
  readonly transient: boolean;
  constructor(
    method: string,
    path: string,
    status: number,
    message: string,
    errcode?: string,
    retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(`${method} ${path}: ${message}${status > 0 ? ` (${String(status)})` : ''}`);
    this.name = 'MatrixError';
    this.status = status;
    this.errcode = errcode;
    this.retryAfterMs = retryAfterMs;
    this.transient = isTransientHttpError({ status, idempotent: method === 'GET', cause });
  }
}

export interface MatrixClientOptions {
  homeserver: string;
  token: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

export function createMatrixApi(opts: MatrixClientOptions): MatrixApi {
  const http = createJsonClient({
    secrets: [opts.token],
    placeholder: '<token>',
    headers: { authorization: `Bearer ${opts.token}` },
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });

  return {
    async call<T>(method: string, path: string, co: MatrixCallOptions = {}): Promise<T> {
      // Paths carry room and event ids, never the token; log-safe as they are.
      const shown = path.split('?')[0] ?? path;
      let res: JsonResponse;
      try {
        res = await http.request({
          method,
          url: `${opts.homeserver}/_matrix/client/v3${path}`,
          query: co.query,
          body: co.body,
          timeoutMs: co.timeoutMs ?? opts.timeoutMs,
        });
      } catch (err) {
        throw err instanceof HttpTransportError
          ? new MatrixError(method, shown, 0, err.message, undefined, undefined, err)
          : err;
      }
      if (!res.json) {
        throw new MatrixError(method, shown, res.status, 'non-JSON response');
      }
      if (!res.ok) {
        const b = (res.body ?? {}) as { errcode?: string; error?: string; retry_after_ms?: number };
        const header = Number(res.headers.get('retry-after'));
        const retry =
          b.retry_after_ms ?? (Number.isFinite(header) && header > 0 ? header * 1000 : undefined);
        throw new MatrixError(
          method,
          shown,
          res.status,
          http.redact(b.error ?? b.errcode ?? 'request failed'),
          b.errcode,
          res.status === 429 ? (retry ?? 5000) : undefined,
        );
      }
      return res.body as T;
    },
  };
}

/** Encodes one path segment (room ids and aliases contain `!`, `#`, `:`). */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
