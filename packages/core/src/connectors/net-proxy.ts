/**
 * The filtering proxy behind a sandboxed agent program's network allowlist
 * (`sandbox.network.allow` on an `acp` manifest; ARCHITECTURE §6, §11). The sandbox has no
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

/** How one request ended, for the metric. */
export type NetProxyResult = 'allowed' | 'denied' | 'failed';

export interface NetProxyOptions {
  /** `sandbox.network.allow`, as validated by the manifest schema. */
  allow: readonly string[];
  /** Where to listen: a path in a directory only the daemon can enter. */
  socket: string;
  log: Logger;
  /** Called once per request (`CONNECT` or plain HTTP) with how it ended. */
  onRequest?: ((result: NetProxyResult) => void) | undefined;
  /** Name resolution; defaults to `dns.lookup` (tests point names at a local server). */
  lookup?: LookupFunction | undefined;
  /** How long an upstream may take to accept a connection. */
  connectTimeoutMs?: number | undefined;
}

export interface NetProxy {
  /** The socket the proxy listens on. */
  readonly socket: string;
  /** Stops listening, drops every open connection and removes the socket. Idempotent. */
  close(): Promise<void>;
}

/** Longest Unix socket path the platform accepts (`sun_path` less the terminating NUL). */
const MAX_SOCKET_PATH = process.platform === 'linux' ? 107 : 103;
const CONNECT_TIMEOUT_MS = 30_000;
/** Distinct targets whose first refusal or failure is logged at `warn`; later ones at `debug`. */
const MAX_NOTED = 256;

/** Addresses that are not the public internet: loopback, private, link-local, multicast, reserved. */
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
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, 'ipv6');
}

/** True for an address a wildcard entry must not reach (IPv4-mapped IPv6 is judged as IPv4). */
export function isNonPublicAddress(address: string): boolean {
  return NON_PUBLIC.check(address, isIPv6(address) ? 'ipv6' : 'ipv4');
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
  /** `warn` the first time a target is refused or fails, `debug` after: an agent retries. */
  const note = (msg: string, target: Target, reason: string): void => {
    const key = `${msg} ${target.host}:${String(target.port)}`;
    const first = !noted.has(key) && noted.size < MAX_NOTED;
    if (first) {
      noted.add(key);
    }
    log[first ? 'warn' : 'debug'](msg, { host: target.host, port: target.port, reason });
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
  server.on('connection', track);

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
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
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
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
      count('allowed');
      log.debug('sandbox.net_request', {
        host: target.host,
        port: target.port,
        method: req.method ?? null,
        status: up.statusCode ?? null,
      });
      res.writeHead(up.statusCode ?? 502, up.statusMessage, endToEnd(up.headers));
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    upstream.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const { status, body } = unreachable(target, err);
      text(status, body);
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  rmSync(opts.socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(opts.socket, 0o600);
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
