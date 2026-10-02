/**
 * Connector ops as agent tools (`mcp_servers` on an `agent` action; ARCHITECTURE §5.4,
 * §6). The agent must never hold a connector's secrets, so it is not handed the connector
 * itself: per run, the core listens on a private Unix socket under `work_dir` and serves
 * one MCP server per granted connector there, forwarding each call over the supervisor's
 * existing client. What the agent spawns (an ACP `mcpServers` stdio entry) is a small
 * proxy that knows only the socket path and a per-run token: it pipes its stdin and
 * stdout to the socket. Only the granted ops are listed and callable; the connector's own
 * `ops` allowlist still applies underneath.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type { Logger } from '../log.js';
import { VERSION } from '../version.js';
import type { McpServerLaunch } from './acp-types.js';

/** One `mcp_servers` entry: a `stdio` connector and the ops the agent may call (`[]` = every op its manifest allows). */
export interface ToolGrant {
  connector: string;
  ops: readonly string[];
}

/** What the bridge needs from the supervisor. */
export interface ConnectorTools {
  /** The tools the connector serves that its manifest's `ops` let the core call. */
  listTools(connector: string, opts: { signal: AbortSignal }): Promise<Tool[]>;
  /** One call, the result as the connector returned it (an `isError` result is not thrown). */
  callTool(
    connector: string,
    op: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal },
  ): Promise<CallToolResult>;
}

export interface ToolBridgeOptions {
  grants: readonly ToolGrant[];
  tools: ConnectorTools;
  /** Directory for the socket; created 0700. Must be visible to a sandboxed agent (`<work_dir>/.mcp`). */
  dir: string;
  /** The run's signal: in-flight calls are aborted with it. */
  signal: AbortSignal;
  log: Logger;
  /** The Node that runs the proxy; defaults to the daemon's own (visible in the sandbox). */
  execPath?: string | undefined;
}

export interface ToolBridge {
  /** The ACP `mcpServers` entries: one proxy per granted connector, named after it. */
  readonly servers: McpServerLaunch[];
  /** Stops listening, drops open connections and removes the socket. Idempotent. */
  close(): Promise<void>;
}

/**
 * The proxy the agent spawns, run as `node -e` so it needs no file of its own and works
 * the same in a checkout, a release tree and the bwrap sandbox (which shows the daemon's
 * Node). It sends one hello line (`{token, server}`) and then pipes bytes both ways.
 */
export const PROXY_SOURCE = `'use strict';
const net = require('node:net');
const env = process.env;
const sock = net.connect(env.OA_MCP_SOCKET);
sock.on('connect', () => {
  sock.write(JSON.stringify({ token: env.OA_MCP_TOKEN, server: env.OA_MCP_SERVER }) + '\\n');
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
});
sock.on('error', (err) => {
  process.stderr.write('247-agent mcp proxy: ' + err.message + '\\n');
  process.exit(1);
});
sock.on('close', () => process.stdin.destroy());
`;

/** Longest Unix socket path the platform accepts (`sun_path` less the terminating NUL). */
export const MAX_SOCKET_PATH = process.platform === 'linux' ? 107 : 103;
/** A client that has not said hello by then is dropped. */
const HELLO_TIMEOUT_MS = 10_000;
const HELLO_MAX_BYTES = 4096;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function parseHello(line: Buffer): { token: string; server: string } | undefined {
  try {
    const hello = JSON.parse(line.toString('utf8')) as unknown;
    if (hello === null || typeof hello !== 'object') {
      return undefined;
    }
    const { token, server } = hello as Record<string, unknown>;
    return typeof token === 'string' && typeof server === 'string' ? { token, server } : undefined;
  } catch {
    return undefined;
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function allows(grant: ToolGrant, op: string): boolean {
  return grant.ops.length === 0 || grant.ops.includes(op);
}

/** Serves one granted connector as an MCP server on an accepted, authenticated socket. */
async function serve(sock: Socket, grant: ToolGrant, opts: ToolBridgeOptions): Promise<void> {
  const { connector } = grant;
  const log = opts.log;
  // The low-level server: tools are passed through with the connector's own JSON Schemas.
  const mcp = new McpServer({ name: connector, version: VERSION }, { capabilities: { tools: {} } });
  const server = mcp.server;
  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    const tools = await opts.tools.listTools(connector, {
      signal: AbortSignal.any([extra.signal, opts.signal]),
    });
    return { tools: tools.filter((t) => allows(grant, t.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const op = req.params.name;
    const signal = AbortSignal.any([extra.signal, opts.signal]);
    const startedAt = Date.now();
    try {
      // With no ops named, the op must be one the connector lists (keeps metric labels bounded).
      const known =
        grant.ops.length > 0 ||
        (await opts.tools.listTools(connector, { signal })).some((t) => t.name === op);
      if (!allows(grant, op) || !known) {
        log.warn('agent.mcp_call', { connector, op, ok: false, error: 'not granted' });
        return failure(`${op} is not one of the ops this run may call on ${connector}`);
      }
      const result = await opts.tools.callTool(connector, op, req.params.arguments ?? {}, {
        signal,
      });
      log.info('agent.mcp_call', {
        connector,
        op,
        ok: result.isError !== true,
        duration_ms: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      log.warn('agent.mcp_call', {
        connector,
        op,
        ok: false,
        duration_ms: Date.now() - startedAt,
        error: errorMessage(err),
      });
      return failure(errorMessage(err));
    }
  });
  sock.on('close', () => {
    void mcp.close();
  });
  await mcp.connect(new StdioServerTransport(sock, sock));
  // Paused explicitly after the hello, so the transport's `data` listener does not resume it.
  sock.resume();
}

/**
 * Opens the bridge for one run: a socket at `<dir>/<random>.sock` (0600, in a 0700
 * directory) that accepts only clients presenting this run's token and naming a granted
 * connector. Every accepted connection is its own MCP session.
 */
export async function openToolBridge(opts: ToolBridgeOptions): Promise<ToolBridge> {
  const grants = new Map(opts.grants.map((g) => [g.connector, g]));
  const token = randomBytes(24).toString('base64url');
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const path = join(opts.dir, `${randomBytes(6).toString('hex')}.sock`);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    throw new Error(
      `the tool socket path ${path} is longer than ${String(MAX_SOCKET_PATH)} bytes: use a shorter work_dir`,
    );
  }
  const sockets = new Set<Socket>();
  const net = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', (err) => {
      opts.log.debug('agent.mcp_socket_error', { error: err.message });
    });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), HELLO_TIMEOUT_MS);
    timer.unref();
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > HELLO_MAX_BYTES) {
          clearTimeout(timer);
          sock.destroy();
        }
        return;
      }
      clearTimeout(timer);
      sock.off('data', onData);
      sock.pause();
      const hello = parseHello(buf.subarray(0, nl));
      const grant =
        hello !== undefined && sameToken(hello.token, token) ? grants.get(hello.server) : undefined;
      if (grant === undefined) {
        opts.log.warn('agent.mcp_refused', {
          server: hello?.server.slice(0, 100) ?? null,
          reason:
            hello === undefined
              ? 'bad hello'
              : grants.has(hello.server)
                ? 'bad token'
                : 'not granted',
        });
        sock.destroy();
        return;
      }
      const rest = buf.subarray(nl + 1);
      if (rest.length > 0) {
        sock.unshift(rest);
      }
      serve(sock, grant, opts).catch((err: unknown) => {
        opts.log.warn('agent.mcp_serve_failed', {
          connector: grant.connector,
          error: errorMessage(err),
        });
        sock.destroy();
      });
    };
    sock.on('data', onData);
  });
  rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    net.once('error', reject);
    net.listen(path, () => {
      net.off('error', reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  opts.log.info('agent.mcp_bridge', { socket: path, servers: [...grants.keys()].join(',') });

  let closed: Promise<void> | undefined;
  const execPath = opts.execPath ?? process.execPath;
  return {
    servers: [...grants.keys()].map((name) => ({
      name,
      command: execPath,
      args: ['-e', PROXY_SOURCE],
      env: { OA_MCP_SOCKET: path, OA_MCP_TOKEN: token, OA_MCP_SERVER: name },
    })),
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        for (const s of sockets) {
          s.destroy();
        }
        net.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
      });
      return closed;
    },
  };
}
