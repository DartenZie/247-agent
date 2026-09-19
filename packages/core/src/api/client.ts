import { request as httpRequest } from 'node:http';

import type { ManualInput } from '../bus/manual.js';
import type { PublishResult } from '../bus/publish.js';
import type { ConfigIssue } from '../config/load.js';
import type { RunFilter } from '../store/runs.js';
import type { EventRecord, NewEvent, RunRecord } from '../store/types.js';
import type { HealthBody, RunResponse } from './routes.js';

export const DEFAULT_SOCKET = '/run/online-agent/core.sock';

export interface ApiClientOptions {
  socketPath: string;
  /** Per request; the daemon answers everything synchronously, so this is a safety net. */
  timeoutMs?: number;
}

/** The daemon answered with an error status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: ConfigIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The socket could not be reached: the daemon is down or the path is wrong. */
export class ApiConnectionError extends Error {
  constructor(
    readonly socketPath: string,
    readonly code: string,
  ) {
    super(`cannot connect to the daemon at ${socketPath} (${code})`);
    this.name = 'ApiConnectionError';
  }
}

interface ErrorBody {
  error?: unknown;
  issues?: unknown;
}

function parseIssues(v: unknown): ConfigIssue[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v.flatMap((i: unknown) =>
    i !== null && typeof i === 'object' && 'message' in i && typeof i.message === 'string'
      ? [{ path: 'path' in i && typeof i.path === 'string' ? i.path : '', message: i.message }]
      : [],
  );
}

/** Typed client for the daemon's socket API; used by the CLI and by TypeScript connectors. */
export class ApiClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.socketPath = opts.socketPath;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  health(): Promise<HealthBody> {
    return this.request<HealthBody>('GET', '/v1/health');
  }

  emit(event: NewEvent): Promise<PublishResult> {
    return this.request<PublishResult>('POST', '/v1/events', event);
  }

  run(task: string, input?: ManualInput): Promise<RunResponse> {
    const body: Record<string, unknown> = { task };
    if (input?.type !== undefined || input?.payload !== undefined) {
      body.event = { type: input.type, payload: input.payload };
    }
    if (input?.correlation_id !== undefined) {
      body.correlation_id = input.correlation_id;
    }
    return this.request<RunResponse>('POST', '/v1/runs', body);
  }

  getRun(id: string): Promise<RunRecord> {
    return this.request<RunRecord>('GET', `/v1/runs/${encodeURIComponent(id)}`);
  }

  async listRuns(filter: RunFilter = {}): Promise<RunRecord[]> {
    const q = new URLSearchParams();
    if (filter.status !== undefined) {
      q.set('status', filter.status);
    }
    if (filter.task !== undefined) {
      q.set('task', filter.task);
    }
    if (filter.limit !== undefined) {
      q.set('limit', String(filter.limit));
    }
    const qs = q.size === 0 ? '' : `?${q.toString()}`;
    const { runs } = await this.request<{ runs: RunRecord[] }>('GET', `/v1/runs${qs}`);
    return runs;
  }

  getEvent(id: string): Promise<EventRecord> {
    return this.request<EventRecord>('GET', `/v1/events/${encodeURIComponent(id)}`);
  }

  private request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path,
          timeout: this.timeoutMs,
          headers: {
            accept: 'application/json',
            connection: 'close',
            ...(payload === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            if (text !== '') {
              try {
                parsed = JSON.parse(text);
              } catch {
                reject(new ApiError(res.statusCode ?? 0, `non-JSON response: ${text}`));
                return;
              }
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(parsed as T);
              return;
            }
            const e = (parsed ?? {}) as ErrorBody;
            const message = typeof e.error === 'string' ? e.error : `HTTP ${String(status)}`;
            reject(new ApiError(status, message, parseIssues(e.issues)));
          });
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`request timed out after ${String(this.timeoutMs)}ms`));
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
          reject(new ApiConnectionError(this.socketPath, err.code));
        } else {
          reject(err);
        }
      });
      req.end(payload);
    });
  }
}
