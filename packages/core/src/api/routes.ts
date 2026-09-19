import { z } from 'zod';

import { UnknownTaskError } from '../bus/manual.js';
import { InvalidEventError, type PublishResult } from '../bus/publish.js';
import type { Clock } from '../clock.js';
import { issuesFromZod, type ConfigIssue } from '../config/load.js';
import type { Core } from '../core.js';
import type { StateEntry } from '../store/state.js';
import type { EventRecord, JsonValue, RunRecord } from '../store/types.js';

/**
 * The HTTP API (ARCHITECTURE §4), transport-free: `route()` takes a parsed request and
 * returns a status + JSON body, so the handlers are testable without a socket and the
 * server file is plumbing only. `/v1/state` arrives with the KV store.
 */

export interface ApiRequest {
  method: string;
  /** Path without query string, e.g. `/v1/runs/run_…`. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body; `undefined` when the body was empty. */
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: JsonValue;
}

export interface RouteContext {
  core: Core;
  clock: Clock;
  startedAt: Date;
  /** Reported by `/v1/health`. */
  configFile: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: ConfigIssue[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
  }

  toResponse(): ApiResponse {
    const body: Record<string, JsonValue> = { error: this.message };
    if (this.issues !== undefined) {
      body.issues = this.issues.map((i) => ({ path: i.path, message: i.message }));
    }
    return { status: this.status, body };
  }
}

export interface HealthBody {
  ok: true;
  pid: number;
  started_at: string;
  uptime_s: number;
  config_file: string;
  tasks: number;
  runs: { pending: number; in_flight: number };
  [key: string]: JsonValue;
}

export interface RunResponse {
  event_id: string;
  run: RunRecord;
}

const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const;

/** `POST /v1/events`: the connector-facing event shape. */
export const EmitBody = z.strictObject({
  type: z.string().min(1),
  /** The connector's name; `api` when omitted. */
  source: z.string().min(1).default('api'),
  payload: z.json().optional(),
  dedup_key: z.string().min(1).optional(),
  parent_id: z.string().min(1).optional(),
  correlation_id: z.string().min(1).optional(),
});

/** `POST /v1/runs`: `oa run <task> [--event …]`. */
export const RunBody = z.strictObject({
  task: z.string().min(1),
  event: z
    .strictObject({
      type: z.string().min(1).optional(),
      payload: z.json().optional(),
    })
    .optional(),
  correlation_id: z.string().min(1).optional(),
});

/** `PUT /v1/state/{ns}/{key}`. */
export const PutStateBody = z.strictObject({ value: z.json() });

const ListRunsQuery = z.strictObject({
  status: z.enum(RUN_STATUSES).optional(),
  task: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

function parse<T extends z.ZodType>(schema: T, input: unknown, what: string): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new ApiError(400, `invalid ${what}`, issuesFromZod(r.error));
  }
  return r.data;
}

function health(ctx: RouteContext): HealthBody {
  const now = ctx.clock.now();
  return {
    ok: true,
    pid: process.pid,
    started_at: ctx.startedAt.toISOString(),
    uptime_s: Math.max(0, Math.round((now.getTime() - ctx.startedAt.getTime()) / 1000)),
    config_file: ctx.configFile,
    tasks: ctx.core.config().tasks.length,
    runs: ctx.core.executor.stats(),
  };
}

function emit(ctx: RouteContext, body: unknown): ApiResponse {
  const input = parse(EmitBody, body, 'event');
  let result: PublishResult;
  try {
    result = ctx.core.bus.publish(input);
  } catch (err) {
    if (err instanceof InvalidEventError) {
      throw new ApiError(400, err.message);
    }
    throw err;
  }
  // The store's shape is already JSON; the cast just names it for the response type.
  return { status: result.status === 'inserted' ? 201 : 200, body: result as unknown as JsonValue };
}

function runTask(ctx: RouteContext, body: unknown): ApiResponse {
  const input = parse(RunBody, body, 'run request');
  try {
    const result: RunResponse = ctx.core.runTask(input.task, {
      type: input.event?.type,
      payload: input.event?.payload,
      correlation_id: input.correlation_id,
    });
    return { status: 201, body: result as unknown as JsonValue };
  } catch (err) {
    if (err instanceof UnknownTaskError) {
      throw new ApiError(404, err.message);
    }
    throw err;
  }
}

function listRuns(ctx: RouteContext, query: URLSearchParams): ApiResponse {
  const q = parse(ListRunsQuery, Object.fromEntries(query), 'query');
  const runs: RunRecord[] = ctx.core.store.runs.list({
    status: q.status,
    task: q.task,
    limit: q.limit,
  });
  return { status: 200, body: { runs: runs as unknown as JsonValue } };
}

function getRun(ctx: RouteContext, id: string): ApiResponse {
  const run = ctx.core.store.runs.getById(id);
  if (run === undefined) {
    throw new ApiError(404, `unknown run "${id}"`);
  }
  return { status: 200, body: run as unknown as JsonValue };
}

function getEvent(ctx: RouteContext, id: string): ApiResponse {
  const event: EventRecord | undefined = ctx.core.store.events.getById(id);
  if (event === undefined) {
    throw new ApiError(404, `unknown event "${id}"`);
  }
  return { status: 200, body: event as unknown as JsonValue };
}

function getState(ctx: RouteContext, ns: string, key: string): ApiResponse {
  const entry: StateEntry | undefined = ctx.core.store.state.get(ns, key);
  if (entry === undefined) {
    throw new ApiError(404, `no state for ${ns}/${key}`);
  }
  return { status: 200, body: entry as unknown as JsonValue };
}

function putState(ctx: RouteContext, ns: string, key: string, body: unknown): ApiResponse {
  const input = parse(PutStateBody, body, 'state value');
  const now = ctx.clock.now().toISOString();
  ctx.core.store.state.put(ns, key, input.value, now);
  return { status: 200, body: { namespace: ns, key, value: input.value, updated_at: now } };
}

function deleteState(ctx: RouteContext, ns: string, key: string): ApiResponse {
  return { status: 200, body: { deleted: ctx.core.store.state.delete(ns, key) } };
}

function listState(ctx: RouteContext, ns: string): ApiResponse {
  const entries: StateEntry[] = ctx.core.store.state.list(ns);
  return { status: 200, body: { entries: entries as unknown as JsonValue } };
}

const RUN_PATH = /^\/v1\/runs\/([^/]+)$/;
const EVENT_PATH = /^\/v1\/events\/([^/]+)$/;
const STATE_NS_PATH = /^\/v1\/state\/([^/]+)$/;
const STATE_KEY_PATH = /^\/v1\/state\/([^/]+)\/([^/]+)$/;

/** Throws `ApiError` for client errors; anything else is a 500 for the server to map. */
export function route(ctx: RouteContext, req: ApiRequest): ApiResponse {
  const { method, path } = req;
  if (path === '/v1/health') {
    return only(method, 'GET', () => ({ status: 200, body: health(ctx) }));
  }
  if (path === '/v1/events') {
    return only(method, 'POST', () => emit(ctx, req.body));
  }
  if (path === '/v1/runs') {
    if (method === 'GET') {
      return listRuns(ctx, req.query);
    }
    return only(method, 'POST', () => runTask(ctx, req.body));
  }
  const run = RUN_PATH.exec(path);
  if (run?.[1] !== undefined) {
    const id = run[1];
    return only(method, 'GET', () => getRun(ctx, id));
  }
  const event = EVENT_PATH.exec(path);
  if (event?.[1] !== undefined) {
    const id = event[1];
    return only(method, 'GET', () => getEvent(ctx, id));
  }
  const stateKey = STATE_KEY_PATH.exec(path);
  if (stateKey?.[1] !== undefined && stateKey[2] !== undefined) {
    const ns = decodeURIComponent(stateKey[1]);
    const key = decodeURIComponent(stateKey[2]);
    switch (method) {
      case 'GET':
        return getState(ctx, ns, key);
      case 'PUT':
        return putState(ctx, ns, key, req.body);
      case 'DELETE':
        return deleteState(ctx, ns, key);
      default:
        throw new ApiError(405, `method ${method} not allowed; use GET, PUT or DELETE`);
    }
  }
  const stateNs = STATE_NS_PATH.exec(path);
  if (stateNs?.[1] !== undefined) {
    const ns = decodeURIComponent(stateNs[1]);
    return only(method, 'GET', () => listState(ctx, ns));
  }
  throw new ApiError(404, `no route for ${method} ${path}`);
}

function only(method: string, allowed: string, handler: () => ApiResponse): ApiResponse {
  if (method !== allowed) {
    throw new ApiError(405, `method ${method} not allowed; use ${allowed}`);
  }
  return handler();
}
