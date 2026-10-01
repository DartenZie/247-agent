/**
 * The HTTP side: route a request, read its body up to `max_body`, verify it, and emit one
 * event. The response tells the sender whether to retry: 202 (emitted), 200 (a duplicate
 * delivery), 4xx (never retry this request), 503 (the core is unreachable; retry later).
 */
import { chmodSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  CoreApiError,
  type EmitInput,
  type EmitResult,
  type JsonValue,
} from '@247-agent/connector-sdk';

import { secretHeader, type RouteConfig, type WebhookConfig } from './config.js';
import { verifyRequest } from './verify.js';

/** What the server needs from the core: the SDK's `CoreClient` or a fake in tests. */
export interface CoreLike {
  emitEvent(input: EmitInput): Promise<EmitResult>;
}

export interface WebhookServerOptions {
  config: WebhookConfig;
  core: CoreLike;
  /** The connector's name, the first part of every dedup key. */
  name: string;
  log: (line: string) => void;
  /** Clock for `received_at`; tests pin it. */
  now?: () => Date;
}

/** Headers that carry credentials and never reach an event. */
const ALWAYS_DROPPED = ['authorization', 'cookie', 'proxy-authorization'];

type BodyFormat = 'json' | 'form' | 'text' | 'base64' | 'empty';

/** Payload of an emitted event. */
export interface WebhookPayload {
  route: string;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  content_type: string | null;
  body_format: BodyFormat;
  body: JsonValue;
  remote: string | null;
  received_at: string;
  [key: string]: JsonValue;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** The request listener; exported so tests can drive it without a socket. */
export function createHandler(
  opts: WebhookServerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = new Map(opts.config.routes.map((r) => [r.path, r]));
  const now = opts.now ?? (() => new Date());
  return (req, res) => {
    handle(req, opts, routes, now).then(
      ({ status, body }) => {
        reply(res, status, body);
      },
      (err: unknown) => {
        if (err instanceof HttpError) {
          reply(res, err.status, { ok: false, error: err.message }, err.headers);
          return;
        }
        opts.log(`webhook: internal error: ${err instanceof Error ? err.message : String(err)}`);
        reply(res, 500, { ok: false, error: 'internal error' });
      },
    );
  };
}

async function handle(
  req: IncomingMessage,
  opts: WebhookServerOptions,
  routes: Map<string, RouteConfig>,
  now: () => Date,
): Promise<{ status: number; body: Record<string, JsonValue> }> {
  const url = new URL(req.url ?? '/', 'http://webhook.invalid');
  const method = (req.method ?? 'GET').toUpperCase();
  if (url.pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
    return { status: 200, body: { ok: true } };
  }
  const route = routes.get(url.pathname);
  if (route === undefined) {
    req.resume();
    throw new HttpError(404, 'no such route');
  }
  if (!route.methods.includes(method)) {
    req.resume();
    throw new HttpError(405, 'method not allowed', { allow: route.methods.join(', ') });
  }
  const raw = await readBody(req, opts.config.max_body);
  const verdict = verifyRequest(route.verify, req.headers, raw);
  if (!verdict.ok) {
    opts.log(
      `webhook: rejected ${method} ${route.path} from ${remoteOf(req, opts.config.trust_proxy) ?? 'unix socket'}: ${verdict.reason}`,
    );
    throw new HttpError(401, 'unauthorized');
  }
  const type = eventType(route, req.headers);
  const contentType = headerValue(req.headers['content-type']) ?? null;
  const { format, body } = parseBody(raw, contentType);
  const payload: WebhookPayload = {
    route: route.name,
    method,
    path: url.pathname,
    query: queryOf(url.searchParams),
    headers: keptHeaders(req.headers, route, opts.config.drop_headers),
    content_type: contentType,
    body_format: format,
    body,
    remote: remoteOf(req, opts.config.trust_proxy),
    received_at: now().toISOString(),
  };
  const delivery =
    route.dedup_header === undefined ? undefined : headerValue(req.headers[route.dedup_header]);
  const input: EmitInput = {
    type,
    payload,
    ...(delivery === undefined || delivery === ''
      ? {}
      : { dedup_key: `${opts.name}:${route.name}:${delivery.slice(0, 200)}` }),
  };
  let result: EmitResult;
  try {
    result = await opts.core.emitEvent(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CoreApiError && err.status >= 400 && err.status < 500) {
      opts.log(`webhook: the core refused a ${type} event from ${route.path}: ${message}`);
      throw new HttpError(422, 'event rejected');
    }
    opts.log(`webhook: cannot reach the core for ${type} from ${route.path}: ${message}`);
    throw new HttpError(503, 'core unavailable, retry later', { 'retry-after': '30' });
  }
  if (result.status === 'duplicate') {
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  return { status: 202, body: { ok: true, event_id: result.event.id } };
}

/**
 * The event type: the route's `event`, plus `.<value>` of `type_header` when set. The value
 * is folded into one valid segment (`pull_request_review` stays, `Foo.Bar` becomes `foo_bar`).
 */
export function eventType(route: RouteConfig, headers: IncomingHttpHeaders): string {
  if (route.type_header === undefined) {
    return route.event;
  }
  const value = headerValue(headers[route.type_header]);
  const segment = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (segment === '') {
    throw new HttpError(400, `missing ${route.type_header}`);
  }
  return `${route.event}.${segment}`;
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.reject(new HttpError(413, `body larger than ${String(max)} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > max) {
        done = true;
        req.resume();
        reject(new HttpError(413, `body larger than ${String(max)} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/** JSON and form bodies are parsed; other text stays a string, bytes become base64. */
export function parseBody(
  raw: Buffer,
  contentType: string | null,
): { format: BodyFormat; body: JsonValue } {
  if (raw.length === 0) {
    return { format: 'empty', body: null };
  }
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const text = utf8(raw);
  if (mime === 'application/json' || mime.endsWith('+json')) {
    if (text === undefined) {
      throw new HttpError(400, 'body is not UTF-8');
    }
    try {
      return { format: 'json', body: JSON.parse(text) as JsonValue };
    } catch {
      throw new HttpError(400, 'body is not valid JSON');
    }
  }
  if (mime === 'application/x-www-form-urlencoded' && text !== undefined) {
    return { format: 'form', body: queryOf(new URLSearchParams(text)) };
  }
  if (text !== undefined) {
    return { format: 'text', body: text };
  }
  return { format: 'base64', body: raw.toString('base64') };
}

function utf8(raw: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return undefined;
  }
}

/** Repeated keys become arrays, single ones stay strings. */
function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length === 1 ? (values[0] ?? '') : values;
  }
  return out;
}

function keptHeaders(
  headers: IncomingHttpHeaders,
  route: RouteConfig,
  dropped: readonly string[],
): Record<string, string> {
  const drop = new Set([...ALWAYS_DROPPED, ...dropped]);
  const secret = secretHeader(route.verify);
  if (secret !== undefined) {
    drop.add(secret);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || drop.has(name) || name.startsWith('x-hub-signature')) {
      continue;
    }
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function remoteOf(req: IncomingMessage, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = headerValue(req.headers['x-forwarded-for'])?.split(',')[0]?.trim();
    if (forwarded !== undefined && forwarded !== '') {
      return forwarded;
    }
  }
  return req.socket.remoteAddress ?? null;
}

function reply(
  res: ServerResponse,
  status: number,
  body: Record<string, JsonValue>,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Starts listening as configured; resolves with the server and where it listens. */
export async function startServer(
  opts: WebhookServerOptions,
): Promise<{ server: Server; address: string }> {
  const server = createServer(createHandler(opts));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const listen = opts.config.listen;
  if ('path' in listen) {
    rmSync(listen.path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listen.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(listen.path, parseInt(listen.mode, 8));
    return { server, address: `unix:${listen.path}` };
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = addr !== null && typeof addr === 'object' ? addr.port : listen.port;
  return { server, address: `http://${listen.host}:${String(port)}` };
}
