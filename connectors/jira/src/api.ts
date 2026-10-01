/**
 * A thin Jira REST client over `fetch`: JSON in and out, credentials only in the
 * `Authorization` header, errors that carry Jira's messages but never a credential.
 */
import { authorization, credentials, type JiraConfig } from './config.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface JiraApi {
  /** `path` is relative to `/rest/api/<2|3>`. */
  request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, string | number | undefined>; body?: unknown },
  ): Promise<T>;
}

export class JiraError extends Error {
  /** HTTP status, or 0 for a transport failure. */
  readonly status: number;
  constructor(method: string, path: string, status: number, message: string) {
    super(`${method} ${path}: ${message}${status > 0 ? ` (${String(status)})` : ''}`);
    this.name = 'JiraError';
    this.status = status;
  }
}

export function createJiraApi(config: JiraConfig, fetchFn?: FetchLike): JiraApi {
  const doFetch: FetchLike = fetchFn ?? ((input, init) => fetch(input, init));
  const version = config.deployment === 'cloud' ? '3' : '2';
  const secrets = credentials(config);
  const hide = (text: string): string =>
    secrets.reduce((t, s) => t.split(s).join('<credential>'), text);

  return {
    async request<T>(
      method: string,
      path: string,
      opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
    ): Promise<T> {
      const url = new URL(`${config.base_url}/rest/api/${version}${path}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined) {
          url.searchParams.set(k, String(v));
        }
      }
      let res: Response;
      try {
        res = await doFetch(url.toString(), {
          method,
          headers: {
            accept: 'application/json',
            authorization: authorization(config),
            'user-agent': '247-agent',
            // Jira refuses cookie-less form posts without it; harmless for JSON.
            'x-atlassian-token': 'no-check',
            ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          signal: AbortSignal.timeout(config.timeout),
        });
      } catch (err) {
        const cause = err instanceof Error ? (err.cause ?? err) : err;
        throw new JiraError(
          method,
          path,
          0,
          hide(cause instanceof Error ? cause.message : String(cause)),
        );
      }
      const text = await res.text();
      if (!res.ok) {
        throw new JiraError(method, path, res.status, hide(errorMessage(res.status, text)));
      }
      return (text === '' ? null : JSON.parse(text)) as T;
    },
  };
}

function errorMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };
    const parts = [
      ...(body.errorMessages ?? []),
      ...Object.entries(body.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
      ...(typeof body.message === 'string' ? [body.message] : []),
    ];
    if (parts.length > 0) {
      return parts.join('; ');
    }
  } catch {
    // not JSON
  }
  return `HTTP ${String(status)}`;
}
