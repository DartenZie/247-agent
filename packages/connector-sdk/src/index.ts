/**
 * Helpers for TypeScript connectors (ARCHITECTURE §6). A connector is a process the core
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
}

/**
 * An MCP server exposing `tools` as ops. Each handler's JSON result is returned as one text
 * content block (the core parses it back); a thrown error becomes an `isError` result.
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
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
            ],
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
  });
  await serveStdio(server);
  return rt;
}
