/**
 * A thin GitHub REST client over `fetch`: JSON in and out, the token only in the
 * `Authorization` header, errors that name the status and GitHub's message (and when a
 * rate limit resets) but never the token.
 */
import {
  createJsonClient,
  HttpTransportError,
  isTransientHttpError,
  type FetchLike,
  type JsonResponse,
} from '@247-agent/connector-sdk';

export type { FetchLike };

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** `Accept` override, e.g. `application/vnd.github.diff` for a raw diff. */
  accept?: string;
}

export interface GitHubApi {
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  /** The response body as text (diffs). */
  text(method: string, path: string, opts?: RequestOptions): Promise<string>;
}

export class GitHubError extends Error {
  /** HTTP status, or 0 for a transport failure. */
  readonly status: number;
  /**
   * Worth retrying (`isTransientHttpError`, a POST or PATCH not being idempotent), or a
   * rate limit GitHub answered with 403 (`x-ratelimit-remaining: 0` for the primary one,
   * `retry-after` for a secondary one), which it did not carry out.
   */
  readonly transient: boolean;
  constructor(
    method: string,
    path: string,
    status: number,
    message: string,
    opts: { rateLimited?: boolean; cause?: unknown } = {},
  ) {
    super(`${method} ${path}: ${message}${status > 0 ? ` (${String(status)})` : ''}`);
    this.name = 'GitHubError';
    this.status = status;
    this.transient =
      opts.rateLimited === true ||
      isTransientHttpError({ status, idempotent: isIdempotent(method), cause: opts.cause });
  }
}

export interface GitHubClientOptions {
  token: string;
  apiBase: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

export function createGitHubApi(opts: GitHubClientOptions): GitHubApi {
  const http = createJsonClient({
    secrets: [opts.token],
    placeholder: '<token>',
    headers: {
      authorization: `Bearer ${opts.token}`,
      'user-agent': '247-agent',
      'x-github-api-version': '2022-11-28',
    },
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });

  async function send(method: string, path: string, ro: RequestOptions): Promise<JsonResponse> {
    let res: JsonResponse;
    try {
      res = await http.request({
        method,
        url: opts.apiBase + path,
        query: ro.query,
        headers: { accept: ro.accept ?? 'application/vnd.github+json' },
        body: ro.body,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      throw err instanceof HttpTransportError
        ? new GitHubError(method, path, 0, err.message, { cause: err })
        : err;
    }
    if (!res.ok) {
      throw new GitHubError(method, path, res.status, http.redact(errorMessage(res)), {
        rateLimited:
          res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'),
      });
    }
    return res;
  }

  return {
    async request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
      const res = await send(method, path, ro);
      if (!res.json) {
        throw new GitHubError(method, path, res.status, 'non-JSON response');
      }
      return res.body as T;
    },
    async text(method: string, path: string, ro: RequestOptions = {}): Promise<string> {
      return (await send(method, path, ro)).text;
    },
  };
}

/** Whether the request can run twice with one effect: GET, HEAD, PUT and DELETE. */
function isIdempotent(method: string): boolean {
  return ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method.toUpperCase());
}

function errorMessage(res: JsonResponse): string {
  let message = `HTTP ${String(res.status)}`;
  if (typeof res.body === 'object' && res.body !== null) {
    const body = res.body as { message?: unknown; errors?: unknown };
    if (typeof body.message === 'string') {
      message = body.message;
    }
    const details = (
      Array.isArray(body.errors) ? (body.errors as { message?: unknown }[]) : []
    ).flatMap((e) => (typeof e.message === 'string' ? [e.message] : []));
    if (details.length > 0) {
      message += `: ${details.join('; ')}`;
    }
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      message += ` (rate limited until ${new Date(reset * 1000).toISOString()})`;
    }
  }
  return message;
}
