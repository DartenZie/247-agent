/**
 * A thin GitHub REST client over `fetch`: JSON in and out, the token only in the
 * `Authorization` header, errors that name the status and GitHub's message (and when a
 * rate limit resets) but never the token.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

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
  constructor(method: string, path: string, status: number, message: string) {
    super(`${method} ${path}: ${message}${status > 0 ? ` (${String(status)})` : ''}`);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GitHubClientOptions {
  token: string;
  apiBase: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

export function createGitHubApi(opts: GitHubClientOptions): GitHubApi {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const hide = (text: string): string => text.split(opts.token).join('<token>');

  async function send(method: string, path: string, ro: RequestOptions): Promise<Response> {
    const url = new URL(opts.apiBase + path);
    for (const [k, v] of Object.entries(ro.query ?? {})) {
      if (v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers: {
          accept: ro.accept ?? 'application/vnd.github+json',
          authorization: `Bearer ${opts.token}`,
          'user-agent': '247-agent',
          'x-github-api-version': '2022-11-28',
          ...(ro.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(ro.body === undefined ? {} : { body: JSON.stringify(ro.body) }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? (err.cause ?? err) : err;
      throw new GitHubError(
        method,
        path,
        0,
        hide(cause instanceof Error ? cause.message : String(cause)),
      );
    }
    if (!res.ok) {
      throw new GitHubError(method, path, res.status, hide(await errorMessage(res)));
    }
    return res;
  }

  return {
    async request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
      const res = await send(method, path, ro);
      if (res.status === 204) {
        return null as T;
      }
      const text = await res.text();
      return (text === '' ? null : JSON.parse(text)) as T;
    },
    async text(method: string, path: string, ro: RequestOptions = {}): Promise<string> {
      return (await send(method, path, ro)).text();
    },
  };
}

async function errorMessage(res: Response): Promise<string> {
  let message = `HTTP ${String(res.status)}`;
  try {
    const body = (await res.json()) as { message?: string; errors?: { message?: string }[] };
    if (typeof body.message === 'string') {
      message = body.message;
    }
    const details = (body.errors ?? []).flatMap((e) =>
      typeof e.message === 'string' ? [e.message] : [],
    );
    if (details.length > 0) {
      message += `: ${details.join('; ')}`;
    }
  } catch {
    // not JSON; keep the status
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      message += ` (rate limited until ${new Date(reset * 1000).toISOString()})`;
    }
  }
  return message;
}
