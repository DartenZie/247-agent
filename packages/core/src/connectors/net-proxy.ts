/**
 * The filtering proxy behind a sandboxed agent program's network allowlist
 * (`sandbox.network.allow` on an `acp` manifest; docs/internal/connectors.md, docs/internal/security.md). The sandbox has no
 * network of its own (`--unshare-net`): the one way out is this HTTP proxy, which the
 * daemon serves on a Unix socket bound into that sandbox alone and the bridge inside
 * (`actions/sandbox-net.ts`) offers the agent as `HTTP(S)_PROXY`. It serves `CONNECT
 * host:port` (HTTPS and anything else that tunnels) and absolute-form `http://` requests,
 * and lets through only what an `allow` entry names; the rest gets a 403 and a
 * `sandbox.net_denied` line. It never reads a tunnel: TLS stays end to end, so the
 * allowlist judges the host a client asks for, not what it sends there.
 *
 * Names are resolved here, on the host, and the connection goes to the address that was
 * checked. A wildcard entry (`*.example.com`) never reaches a loopback, private or
 * link-local address: a name anyone can register under an allowed suffix must not point
 * the agent at the host's own services or a cloud metadata endpoint. An entry that names
 * the host exactly (or an IP address) is the operator's word and resolves anywhere.
 */
import { lookup as dnsLookup } from 'node:dns';
import { chmodSync, rmSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { BlockList, connect, isIPv6, type LookupFunction, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { matchNetRule, normaliseHost, parseNetRule } from '../actions/sandbox-net.js';
import type { Logger } from '../log.js';
import { MAX_SOCKET_PATH } from './mcp-bridge.js';

/**
 * How one request ended, for the metric; `dropped` is a connection closed at the limit,
 * before it could ask for anything.
 */
export type NetProxyResult = 'allowed' | 'denied' | 'failed' | 'dropped';

export interface NetProxyOptions {
  /** `sandbox.network.allow`, as validated by the manifest schema. */
  allow: readonly string[];
  /** Where to listen: a path in a directory only the daemon can enter. */
  socket: string;
  log: Logger;
  /**
   * Called once per request (`CONNECT` or plain HTTP) with how it ended, and once per
   * connection dropped at the limit.
   */
  onRequest?: ((result: NetProxyResult) => void) | undefined;
  /** Name resolution; defaults to `dns.lookup` (tests point names at a local server). */
  lookup?: LookupFunction | undefined;
  /** How long an upstream may take to accept a connection. */
  connectTimeoutMs?: number | undefined;
  /** Connections the sandbox may hold open at once, tunnels included. */
  maxConnections?: number | undefined;
}

export interface NetProxy {
  /** The socket the proxy listens on. */
  readonly socket: string;
  /** Stops listening, drops every open connection and removes the socket. Idempotent. */
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 30_000;
/**
 * Connections one sandbox may hold open on its proxy, tunnels included; the next one is
 * closed unanswered. Each costs the daemon up to two descriptors (the client's and the
 * upstream's), so this is what keeps a sandboxed program from running it out of them.
 * Far above what an agent needs: npm keeps 15 connections per registry.
 */
const MAX_CONNECTIONS = 256;
/** Distinct targets whose first refusal or failure is logged at `warn`; later ones at `debug`. */
const MAX_NOTED = 256;

/**
 * Addresses that are not the public internet: loopback, private, link-local, multicast,
 * reserved, and the IPv6 tunnel prefixes whose addresses stand for an IPv4 host this list
 * cannot vouch for (Teredo `2001::/32`, 6to4 `2002::/16`; nothing public is served there).
 */
const NON_PUBLIC = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 96],
  ['64:ff9b:1::', 48],
  ['2001::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, 'ipv6');
}

/** The well-known NAT64 prefix (RFC 6052): its last 32 bits are an IPv4 address. */
const NAT64 = new BlockList();
NAT64.addSubnet('64:ff9b::', 96, 'ipv6');

/** The IPv4 address in the last 32 bits of an IPv6 one, e.g. `64:ff9b::a00:5` → `10.0.0.5`. */
function embeddedV4(address: string): string | undefined {
  let groups: string[];
  try {
    groups = new URL(`http://[${address}]`).hostname.slice(1, -1).split(':');
  } catch {
    return undefined;
  }
  const [high, low] = groups.slice(-2).map((g) => (g === '' ? 0 : parseInt(g, 16)));
  if (high === undefined || low === undefined) {
    return undefined;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * True for an address a wildcard entry must not reach. IPv4-mapped IPv6 is judged as IPv4,
 * and so is an address behind NAT64 (`64:ff9b::/96`), which on an IPv6-only network is how
 * every IPv4 host is reached, the private ones included.
 */
export function isNonPublicAddress(address: string): boolean {
  if (!isIPv6(address)) {
    return NON_PUBLIC.check(address, 'ipv4');
  }
  if (NON_PUBLIC.check(address, 'ipv6')) {
    return true;
  }
  if (!NAT64.check(address, 'ipv6')) {
    return false;
  }
  const v4 = embeddedV4(address);
  return v4 === undefined || NON_PUBLIC.check(v4, 'ipv4');
}

/** A name allowed by a wildcard resolved to nothing but non-public addresses. */
class NonPublicAddressError extends Error {
  constructor(host: string, address: string) {
    super(`${host} resolves to ${address}, which a wildcard entry does not reach`);
    this.name = 'NonPublicAddressError';
  }
}

/** `lookup` that keeps only public addresses, so the socket connects to what was checked. */
export function publicOnly(lookup: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, options, (err, address, family) => {
      if (err !== null) {
        callback(err, address, family);
        return;
      }
      if (typeof address === 'string') {
        if (isNonPublicAddress(address)) {
          callback(new NonPublicAddressError(hostname, address), address, family);
        } else {
          callback(null, address, family);
        }
        return;
      }
      const ok = address.filter((a) => !isNonPublicAddress(a.address));
      if (ok.length === 0) {
        callback(new NonPublicAddressError(hostname, address[0]?.address ?? '?'), address);
      } else {
        callback(null, ok);
      }
    });
  };
}

interface Target {
  host: string;
  port: number;
}

/** `host:port` of a `CONNECT` request. */
function connectTarget(authority: string): Target | undefined {
  const m = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority);
  const [, host, port] = m ?? [];
  if (host === undefined || port === undefined || Number(port) < 1 || Number(port) > 65535) {
    return undefined;
  }
  return { host: normaliseHost(host), port: Number(port) };
}

/** The target and origin-form path of an absolute-form `http://` request. */
function httpTarget(url: string): (Target & { path: string; authority: string }) | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' || u.hostname === '') {
    return undefined;
  }
  return {
    host: normaliseHost(u.hostname),
    port: u.port === '' ? 80 : Number(u.port),
    path: u.pathname + u.search,
    authority: u.host,
  };
}

/** Headers that belong to one hop (RFC 9110 §7.6.1), plus whatever `Connection` names. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const named = (headers.connection ?? '').split(',').map((h) => h.trim().toLowerCase());
  const drop = new Set([...HOP_BY_HOP, ...named]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !drop.has(name)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A complete response on a `CONNECT` socket, which has no `ServerResponse`. */
function reply(sock: Duplex, status: number, reason: string, body: string): void {
  sock.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
}

/**
 * Opens the proxy for one sandboxed program: an HTTP server on `socket` (0600) that
 * applies `allow` to every request. The caller closes it when the program is gone.
 */
export async function openNetProxy(opts: NetProxyOptions): Promise<NetProxy> {
  if (Buffer.byteLength(opts.socket) > MAX_SOCKET_PATH) {
    throw new Error(
      `the proxy socket path ${opts.socket} is longer than ${String(MAX_SOCKET_PATH)} bytes`,
    );
  }
  const rules = opts.allow.map(parseNetRule);
  const lookup = opts.lookup ?? dnsLookup;
  const guarded = publicOnly(lookup);
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const log = opts.log;
  const count = (result: NetProxyResult): void => opts.onRequest?.(result);
  const sockets = new Set<Duplex>();
  const track = (sock: Duplex): void => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  };
  const noted = new Set<string>();
  /**
   * `warn` the first time a target is refused or fails, `debug` after: an agent retries.
   * Past `MAX_NOTED` targets every one is `debug`, which is said once, at `warn`.
   */
  const note = (msg: string, target: Target, reason: string): void => {
    const key = `${msg} ${target.host}:${String(target.port)}`;
    const first = !noted.has(key) && noted.size < MAX_NOTED;
    if (first) {
      noted.add(key);
    }
    log[first ? 'warn' : 'debug'](msg, { host: target.host, port: target.port, reason });
    if (first && noted.size === MAX_NOTED) {
      log.warn('sandbox.net_log_limit', {
        targets: MAX_NOTED,
        reason: 'refusals and failures of further targets are logged at debug',
      });
    }
  };
  const denied = (target: Target): string =>
    `247-agent: ${target.host}:${String(target.port)} is not in this sandbox's network allowlist\n`;
  /** An upstream that could not be reached: refused by the address check, or just down. */
  const unreachable = (target: Target, err: unknown): { status: number; body: string } => {
    if (err instanceof NonPublicAddressError) {
      count('denied');
      note('sandbox.net_denied', target, err.message);
      return { status: 403, body: `247-agent: ${err.message}\n` };
    }
    count('failed');
    note('sandbox.net_failed', target, errorMessage(err));
    return {
      status: 502,
      body: `247-agent: cannot reach ${target.host}:${String(target.port)}: ${errorMessage(err)}\n`,
    };
  };

  const server = createServer();
  server.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
  server.on('connection', track);
  let dropped = false;
  server.on('drop', () => {
    count('dropped');
    // `warn` once: a program at the limit keeps arriving.
    log[dropped ? 'debug' : 'warn']('sandbox.net_dropped', { limit: server.maxConnections });
    dropped = true;
  });

  const onConnect = (req: IncomingMessage, client: Duplex, head: Buffer): void => {
    const target = connectTarget(req.url ?? '');
    if (target === undefined) {
      client.on('error', () => undefined);
      reply(client, 400, 'Bad Request', '247-agent: CONNECT takes host:port\n');
      return;
    }
    const rule = matchNetRule(rules, target.host, target.port);
    if (rule === undefined) {
      count('denied');
      note('sandbox.net_denied', target, 'not in the allowlist');
      client.on('error', () => undefined);
      reply(client, 403, 'Forbidden', denied(target));
      return;
    }
    const upstream: Socket = connect({
      host: target.host,
      port: target.port,
      allowHalfOpen: true,
      lookup: rule.wildcard ? guarded : lookup,
    });
    track(upstream);
    let connected = false;
    upstream.setTimeout(connectTimeoutMs, () => {
      upstream.destroy(new Error(`no connection after ${String(connectTimeoutMs)}ms`));
    });
    upstream.on('connect', () => {
      connected = true;
      upstream.setTimeout(0);
      count('allowed');
      log.debug('sandbox.net_connect', { host: target.host, port: target.port });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(client);
      client.pipe(upstream);
    });
    // Both ends are half-open and piped, so a clean end travels on by itself and nothing
    // buffered is cut short; only a failure on one side tears the other down.
    upstream.on('error', (err) => {
      if (connected) {
        client.destroy();
        return;
      }
      const { status, body } = unreachable(target, err);
      reply(client, status, status === 403 ? 'Forbidden' : 'Bad Gateway', body);
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => {
      if (!connected) {
        upstream.destroy();
      }
    });
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const text = (status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      res.end(body);
    };
    const target = httpTarget(req.url ?? '');
    if (target === undefined) {
      text(400, '247-agent: this is a proxy; it serves CONNECT and absolute http:// requests\n');
      return;
    }
    const rule = matchNetRule(rules, target.host, target.port);
    if (rule === undefined) {
      count('denied');
      note('sandbox.net_denied', target, 'not in the allowlist');
      text(403, denied(target));
      return;
    }
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path: target.path,
      // The Host of the URL that was judged, not the client's header: an allowed address
      // must not be asked for another site it happens to serve.
      headers: { ...endToEnd(req.headers), host: target.authority },
      agent: false,
      lookup: rule.wildcard ? guarded : lookup,
      timeout: connectTimeoutMs,
    });
    upstream.on('socket', (sock) => {
      // The timeout covers getting connected; a slow response is the client's to judge.
      sock.once('connect', () => upstream.setTimeout(0));
    });
    upstream.on('timeout', () => {
      upstream.destroy(new Error(`no connection after ${String(connectTimeoutMs)}ms`));
    });
    upstream.on('response', (up) => {
      try {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, endToEnd(up.headers));
      } catch (err) {
        // A status line this server cannot send on (below 100): the upstream's failure.
        const { status, body } = unreachable(target, err);
        text(status, body);
        return;
      }
      count('allowed');
      log.debug('sandbox.net_request', {
        host: target.host,
        port: target.port,
        method: req.method ?? null,
        status: up.statusCode ?? null,
      });
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    // The client left before an answer: that is not the upstream failing.
    let gone = false;
    upstream.on('error', (err) => {
      if (gone || res.headersSent) {
        res.destroy();
        return;
      }
      const { status, body } = unreachable(target, err);
      text(status, body);
    });
    res.on('close', () => {
      gone = true;
      upstream.destroy();
    });
    req.pipe(upstream);
  };

  // What a sandboxed program sends must never take the daemon down: a throw in a handler
  // ends that one connection.
  const thrown = (err: unknown): void => {
    log.warn('sandbox.net_proxy_error', { error: errorMessage(err) });
  };
  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    try {
      onConnect(req, client, head);
    } catch (err) {
      thrown(err);
      client.destroy();
    }
  });
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    try {
      onRequest(req, res);
    } catch (err) {
      thrown(err);
      res.destroy();
    }
  });

  rmSync(opts.socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    chmodSync(opts.socket, 0o600);
  } catch (err) {
    server.close();
    rmSync(opts.socket, { force: true });
    throw err;
  }
  server.on('error', (err) => {
    log.warn('sandbox.net_proxy_error', { error: err.message });
  });
  log.info('sandbox.net_proxy', { socket: opts.socket, allow: opts.allow.join(',') });

  let closed: Promise<void> | undefined;
  return {
    socket: opts.socket,
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(opts.socket, { force: true });
          resolve();
        });
        for (const s of sockets) {
          s.destroy();
        }
      });
      return closed;
    },
  };
}
