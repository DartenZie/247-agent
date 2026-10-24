/**
 * Helpers for TypeScript connectors (docs/internal/connectors.md). A connector is a process the core
 * spawns with `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and `OA_CONFIG_JSON`; it emits events
 * to the core over the socket and, when it has ops, serves them as an MCP server on stdio.
 *
 * This module has no local imports on purpose: Node can run a connector that imports it
 * straight from source (`node connector.ts`), which the core's tests rely on.
 */
import { request as httpRequest } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { z } from 'zod';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ConnectorEnv {
  /** The core's Unix socket. */
  socket: string;
  /** This connector's name from its manifest. */
  name: string;
  /** The manifest's `config`, secrets already rendered. */
  config: Record<string, JsonValue>;
}

/**
 * Reads the environment the core provides; throws when not started by the core.
 *
 * `OA_CONFIG_JSON` carries the rendered secrets, so it is removed from `env` once read:
 * a subprocess the connector spawns later must not inherit it. Call this once, at start.
 */
export function connectorEnv(env: NodeJS.ProcessEnv = process.env): ConnectorEnv {
  const socket = env.OA_CORE_SOCKET;
  const name = env.OA_CONNECTOR_NAME;
  if (socket === undefined || socket === '' || name === undefined || name === '') {
    throw new Error('OA_CORE_SOCKET and OA_CONNECTOR_NAME are not set (not started by the core?)');
  }
  const raw = env.OA_CONFIG_JSON;
  delete env.OA_CONFIG_JSON;
  const config =
    raw === undefined || raw === '' ? {} : (JSON.parse(raw) as Record<string, JsonValue>);
  return { socket, name, config };
}

export interface EmitInput {
  type: string;
  payload?: JsonValue | undefined;
  /** A second event with the same key is dropped by the core. */
  dedup_key?: string | undefined;
  parent_id?: string | undefined;
  correlation_id?: string | undefined;
}

export type EmitResult =
  | { status: 'inserted'; event: { id: string; correlation_id: string; [k: string]: JsonValue } }
  | { status: 'duplicate'; dedup_key: string };

export interface StateEntry {
  namespace: string;
  key: string;
  value: JsonValue;
  updated_at: string;
}

export class CoreApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CoreApiError';
    this.status = status;
  }
}

/** The connector's view of the core: emit events, read and write its own state namespace. */
export class CoreClient {
  private readonly socket: string;
  private readonly name: string;
  private readonly timeoutMs: number;

  constructor(opts: { socket: string; name: string; timeoutMs?: number }) {
    this.socket = opts.socket;
    this.name = opts.name;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** `POST /v1/events` with `source` set to the connector's name. */
  emitEvent(input: EmitInput): Promise<EmitResult> {
    const body: Record<string, JsonValue> = { type: input.type, source: this.name };
    if (input.payload !== undefined) {
      body.payload = input.payload;
    }
    if (input.dedup_key !== undefined) {
      body.dedup_key = input.dedup_key;
    }
    if (input.parent_id !== undefined) {
      body.parent_id = input.parent_id;
    }
    if (input.correlation_id !== undefined) {
      body.correlation_id = input.correlation_id;
    }
    return this.request<EmitResult>('POST', '/v1/events', body);
  }

  /** `GET /v1/state/<name>/<key>`; `undefined` when unset. */
  async getState(key: string, namespace = this.name): Promise<JsonValue | undefined> {
    try {
      const entry = await this.request<StateEntry>('GET', statePath(namespace, key));
      return entry.value;
    } catch (err) {
      if (err instanceof CoreApiError && err.status === 404) {
        return undefined;
      }
      throw err;
    }
  }

  /** `PUT /v1/state/<name>/<key>`. */
  async putState(key: string, value: JsonValue, namespace = this.name): Promise<void> {
    await this.request<StateEntry>('PUT', statePath(namespace, key), { value });
  }

  private request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socket,
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
            const status = res.statusCode ?? 0;
            let parsed: unknown = null;
            if (text !== '') {
              try {
                parsed = JSON.parse(text);
              } catch {
                reject(new CoreApiError(status, `non-JSON response: ${text}`));
                return;
              }
            }
            if (status >= 200 && status < 300) {
              resolve(parsed as T);
              return;
            }
            const message =
              parsed !== null && typeof parsed === 'object' && 'error' in parsed
                ? String(parsed.error)
                : `HTTP ${String(status)}`;
            reject(new CoreApiError(status, message));
          });
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`request timed out after ${String(this.timeoutMs)}ms`));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
}

function statePath(namespace: string, key: string): string {
  return `/v1/state/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
}

/**
 * The `_meta` key of an `isError` tool result that tells the core the failure is transient:
 * the op did not take effect and may succeed later (a connection failure, a timeout, a
 * rate limit, a 5xx), so the core retries the run under the task's `retry` policy. Any
 * other op error fails the run for good.
 */
export const TRANSIENT_META_KEY = 'oa/transient';

/** An op failure worth retrying. Throw it, or any error with `transient: true`, from a handler. */
export class TransientError extends Error {
  readonly transient = true as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientError';
  }
}

/** Whether `err`, or an error in its `cause` chain, carries `transient: true`. */
export function isTransient(err: unknown): boolean {
  return causes(err).some((e) => (e as { transient?: unknown }).transient === true);
}

/**
 * Node's codes for a connection that could not be made or broke, and for a resolver that
 * did not answer. `ENOTFOUND` is not among them: a name that does not exist is a config error.
 */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Whether `err`, or an error in its `cause` chain, is a network failure by its Node `code`. */
export function isNetworkError(err: unknown): boolean {
  return causes(err).some((e) => {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' && NETWORK_CODES.has(code);
  });
}

/**
 * Whether an HTTP status is worth retrying: 0 (no response: a connection failure or a
 * timeout), 408, 429 and every 5xx but 501 (the server does not implement the request).
 */
export function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status !== 501);
}

/** `err` and its `cause`s, at most eight deep, objects only. */
function causes(err: unknown): object[] {
  const out: object[] = [];
  let e = err;
  while (typeof e === 'object' && e !== null && out.length < 8 && !out.includes(e)) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

/** One op. `input` is a zod raw shape (`{ folder: z.string() }`); the handler gets parsed args. */
export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description?: string;
  input?: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => JsonValue | Promise<JsonValue>;
}

/** Types a tool's handler from its `input` shape; returns the erased form `tools` lists take. */
export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef {
  return def as unknown as ToolDef;
}

export interface ConnectorServerOptions {
  name: string;
  version?: string;
  tools: ToolDef[];
  /**
   * Which thrown errors are transient besides those `isTransient` already finds: the
   * connector's own rule for its libraries' errors (an SMTP 4xx, an HTTP 503).
   */
  transient?: (err: unknown) => boolean;
}

/**
 * An MCP server exposing `tools` as ops. Each handler's JSON result is returned as one text
 * content block (the core parses it back); a thrown error becomes an `isError` result,
 * marked with `_meta["oa/transient"]: true` when it is transient (`TRANSIENT_META_KEY`).
 */
export function createConnectorServer(opts: ConnectorServerOptions): McpServer {
  const server = new McpServer({ name: opts.name, version: opts.version ?? '0.0.0' });
  for (const tool of opts.tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.input === undefined ? {} : { inputSchema: tool.input }),
      },
      async (args: unknown) => {
        try {
          const result = await tool.handler(args as never);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (err) {
          const transient = isTransient(err) || opts.transient?.(err) === true;
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
            ],
            ...(transient ? { _meta: { [TRANSIENT_META_KEY]: true } } : {}),
          };
        }
      },
    );
  }
  return server;
}

/** Serves the ops on stdin/stdout, as the core's supervisor expects. Logs go to stderr. */
export async function serveStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}

export interface ConnectorRuntime {
  env: ConnectorEnv;
  core: CoreClient;
  /** Writes one line to stderr, which the core logs as `connector.output`. */
  log: (line: string) => void;
}

/**
 * The whole boilerplate: read the environment, build the core client, register `tools`
 * and serve them on stdio. `setup` runs first and can start pollers or bots.
 */
export async function runConnector(opts: {
  version?: string;
  tools: (rt: ConnectorRuntime) => ToolDef[];
  setup?: (rt: ConnectorRuntime) => void | Promise<void>;
  /** As in `createConnectorServer`. */
  transient?: (err: unknown) => boolean;
}): Promise<ConnectorRuntime> {
  const env = connectorEnv();
  const rt: ConnectorRuntime = {
    env,
    core: new CoreClient({ socket: env.socket, name: env.name }),
    log: (line) => {
      process.stderr.write(line + '\n');
    },
  };
  await opts.setup?.(rt);
  const server = createConnectorServer({
    name: env.name,
    ...(opts.version === undefined ? {} : { version: opts.version }),
    tools: opts.tools(rt),
    ...(opts.transient === undefined ? {} : { transient: opts.transient }),
  });
  await serveStdio(server);
  return rt;
}
