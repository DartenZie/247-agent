/**
 * A thin Matrix Client-Server API client over `fetch` (spec v1.x, `/_matrix/client/v3`):
 * JSON in and out, the access token only in the `Authorization` header. Errors expose
 * the HTTP status, Matrix's `errcode` and a rate limit's wait so the sync loop can back off.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

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
  constructor(
    method: string,
    path: string,
    status: number,
    message: string,
    errcode?: string,
    retryAfterMs?: number,
  ) {
    super(`${method} ${path}: ${message}${status > 0 ? ` (${String(status)})` : ''}`);
    this.name = 'MatrixError';
    this.status = status;
    this.errcode = errcode;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface MatrixClientOptions {
  homeserver: string;
  token: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

export function createMatrixApi(opts: MatrixClientOptions): MatrixApi {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const hide = (text: string): string => text.split(opts.token).join('<token>');

  return {
    async call<T>(method: string, path: string, co: MatrixCallOptions = {}): Promise<T> {
      const url = new URL(`${opts.homeserver}/_matrix/client/v3${path}`);
      for (const [k, v] of Object.entries(co.query ?? {})) {
        if (v !== undefined) {
          url.searchParams.set(k, String(v));
        }
      }
      // Paths carry room and event ids, never the token; log-safe as they are.
      const shown = path.split('?')[0] ?? path;
      let res: Response;
      try {
        res = await doFetch(url.toString(), {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${opts.token}`,
            ...(co.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(co.body === undefined ? {} : { body: JSON.stringify(co.body) }),
          signal: AbortSignal.timeout(co.timeoutMs ?? opts.timeoutMs),
        });
      } catch (err) {
        const cause = err instanceof Error ? (err.cause ?? err) : err;
        throw new MatrixError(
          method,
          shown,
          0,
          hide(cause instanceof Error ? cause.message : String(cause)),
        );
      }
      const text = await res.text();
      let body: unknown;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        throw new MatrixError(method, shown, res.status, 'non-JSON response');
      }
      if (!res.ok) {
        const b = (body ?? {}) as { errcode?: string; error?: string; retry_after_ms?: number };
        const header = Number(res.headers.get('retry-after'));
        const retry =
          b.retry_after_ms ?? (Number.isFinite(header) && header > 0 ? header * 1000 : undefined);
        throw new MatrixError(
          method,
          shown,
          res.status,
          hide(b.error ?? b.errcode ?? 'request failed'),
          b.errcode,
          res.status === 429 ? (retry ?? 5000) : undefined,
        );
      }
      return body as T;
    },
  };
}

/** Encodes one path segment (room ids and aliases contain `!`, `#`, `:`). */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
