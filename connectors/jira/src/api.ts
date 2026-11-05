/**
 * A thin Jira REST client over `fetch`: JSON in and out, credentials only in the
 * `Authorization` header, errors that carry Jira's messages but never a credential.
 */
import {
  createJsonClient,
  HttpTransportError,
  isTransientHttpError,
  type FetchLike,
  type JsonResponse,
} from '@247-agent/connector-sdk';

import { authorization, credentials, type JiraConfig } from './config.js';

export type { FetchLike };

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
  /**
   * Worth retrying (`isTransientHttpError`). GET, PUT and DELETE are idempotent; a POST is
   * not, except a search, which only reads.
   */
  readonly transient: boolean;
  constructor(method: string, path: string, status: number, message: string, cause?: unknown) {
    super(`${method} ${path}: ${message}${status > 0 ? ` (${String(status)})` : ''}`);
    this.name = 'JiraError';
    this.status = status;
    const idempotent =
      ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method.toUpperCase()) ||
      /^\/search(\/|$)/.test(path);
    this.transient = isTransientHttpError({ status, idempotent, cause });
  }
}

export function createJiraApi(config: JiraConfig, fetchFn?: FetchLike): JiraApi {
  const version = config.deployment === 'cloud' ? '3' : '2';
  const http = createJsonClient({
    secrets: credentials(config),
    placeholder: '<credential>',
    headers: {
      authorization: authorization(config),
      'user-agent': '247-agent',
      // Jira refuses cookie-less form posts without it; harmless for JSON.
      'x-atlassian-token': 'no-check',
    },
    ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
  });

  return {
    async request<T>(
      method: string,
      path: string,
      opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
    ): Promise<T> {
      let res: JsonResponse;
      try {
        res = await http.request({
          method,
          url: `${config.base_url}/rest/api/${version}${path}`,
          query: opts.query,
          body: opts.body,
          timeoutMs: config.timeout,
        });
      } catch (err) {
        throw err instanceof HttpTransportError
          ? new JiraError(method, path, 0, err.message, err)
          : err;
      }
      if (!res.ok) {
        throw new JiraError(method, path, res.status, http.redact(errorMessage(res)));
      }
      if (!res.json) {
        throw new JiraError(method, path, res.status, 'non-JSON response');
      }
      return res.body as T;
    },
  };
}

function errorMessage(res: JsonResponse): string {
  if (typeof res.body === 'object' && res.body !== null) {
    const body = res.body as {
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
  }
  return `HTTP ${String(res.status)}`;
}
