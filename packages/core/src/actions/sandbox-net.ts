import { isIP, isIPv4, isIPv6 } from 'node:net';

import { z } from 'zod';

/**
 * The network of a sandboxed agent program (`sandbox.network` on an `acp` manifest;
 * ARCHITECTURE §6, §11). bwrap can only share the host's network or cut it off, so an
 * allowlist is three parts: the sandbox gets its own, empty network namespace
 * (`--unshare-net`); the daemon runs a filtering HTTP proxy on a Unix socket outside it
 * (`connectors/net-proxy.ts`) and binds that one socket in; and a small bridge inside the
 * sandbox (`NET_BRIDGE_SOURCE`) listens on its loopback, pipes every connection to the
 * socket and starts the agent with the proxy variables pointing at itself. This file holds
 * what the config and the proxy share: the entry grammar and the matcher.
 */

/** One `allow` entry, parsed. */
export interface NetRule {
  /** Lower case, no brackets; for a wildcard, the suffix after `*.`. */
  host: string;
  /** `*.example.com`: any name below `example.com`, not `example.com` itself. */
  wildcard: boolean;
  port: number | '*';
}

/** What an entry without a port allows: HTTPS. */
export const DEFAULT_NET_PORT = 443;

const LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?';
const HOSTNAME = new RegExp(`^(\\*\\.)?${LABEL}(?:\\.${LABEL})*$`);
const ENTRY = /^(\[[^\]]+\]|[^:[\]]+)(?::(\*|\d{1,5}))?$/;

/** An IPv6 address as Node and the URL parser spell it, so both sides of a match agree. */
function canonicalV6(address: string): string {
  return new URL(`http://[${address}]`).hostname.slice(1, -1);
}

/**
 * A host as the matcher compares it: lower case, without the brackets of an IPv6 literal
 * and without the trailing dot of a fully qualified name.
 */
export function normaliseHost(host: string): string {
  const h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) {
    const inner = h.slice(1, -1);
    return isIPv6(inner) ? canonicalV6(inner) : inner;
  }
  if (isIPv6(h)) {
    return canonicalV6(h);
  }
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/**
 * Parses `host[:port]`: a hostname, `*.suffix` for every name below one, an IPv4 address
 * or a bracketed IPv6 address; the port is a number or `*` and defaults to 443. Throws
 * with a message for `oa validate`.
 */
export function parseNetRule(entry: string): NetRule {
  const m = ENTRY.exec(entry);
  const [, rawHost, rawPort] = m ?? [];
  if (rawHost === undefined) {
    throw new Error(
      `"${entry}" is not host[:port] (api.anthropic.com, *.npmjs.org, 10.0.0.5:8080, [::1]:8080, host:*)`,
    );
  }
  let port: NetRule['port'] = DEFAULT_NET_PORT;
  if (rawPort === '*') {
    port = '*';
  } else if (rawPort !== undefined) {
    port = Number(rawPort);
    if (port < 1 || port > 65535) {
      throw new Error(`"${entry}": the port must be 1-65535 or *`);
    }
  }
  const host = rawHost.toLowerCase();
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1);
    if (!isIPv6(inner)) {
      throw new Error(`"${entry}": [${inner}] is not an IPv6 address`);
    }
    return { host: canonicalV6(inner), wildcard: false, port };
  }
  if (isIPv4(host)) {
    return { host, wildcard: false, port };
  }
  if (!HOSTNAME.test(host)) {
    throw new Error(
      `"${entry}": the host must be a hostname, "*." and a suffix (*.example.com) or an IP address`,
    );
  }
  const wildcard = host.startsWith('*.');
  return { host: wildcard ? host.slice(2) : host, wildcard, port };
}

/**
 * The rule that lets `host:port` through, if any. A rule that names the host wins over a
 * wildcard that covers it, because the proxy trusts the two differently (a wildcard never
 * reaches a private address); for the same reason a wildcard covers names only, never an
 * address, which is connected to without a lookup to check. `host` is normalised here.
 */
export function matchNetRule(
  rules: readonly NetRule[],
  host: string,
  port: number,
): NetRule | undefined {
  const h = normaliseHost(host);
  const onPort = rules.filter((r) => r.port === '*' || r.port === port);
  return (
    onPort.find((r) => !r.wildcard && r.host === h) ??
    (isIP(h) === 0 ? onPort.find((r) => r.wildcard && h.endsWith(`.${r.host}`)) : undefined)
  );
}

/**
 * `network` of an agent sandbox. `allow` lists what the program may reach, through the
 * daemon's proxy and nothing else; `allow: []` is no network at all. Without `network`
 * the sandbox shares the host's network, as before.
 */
export const SandboxNetwork = z.strictObject({
  allow: z.array(z.string().min(1)).superRefine((entries, ctx) => {
    entries.forEach((entry, i) => {
      try {
        parseNetRule(entry);
      } catch (err) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }),
});

export type SandboxNetworkConfig = z.infer<typeof SandboxNetwork>;

/** Where the proxy's socket is bound inside the sandbox: its private `/tmp`, which always exists. */
export const SANDBOX_NET_SOCKET = '/tmp/.247-agent-net.sock';

/** What the bridge tells clients to reach directly: the sandbox's own loopback. */
export const NET_NO_PROXY = 'localhost,127.0.0.1,::1';

/**
 * The bridge, the first process inside a sandbox with an allowlist, run as
 * `node -e <this> -- <socket> <command…>` so it needs no file of its own (like the tool
 * bridge's proxy, `connectors/mcp-bridge.ts`). HTTP clients take a proxy as a TCP address,
 * and the daemon's proxy is a Unix socket: this listens on a free loopback port of the
 * sandbox's own network namespace, pipes every connection to the socket unchanged (both
 * ends half-open, so a clean end travels on and only a failure tears the pair down), and
 * runs the command with the proxy variables set (both spellings; `NODE_USE_ENV_PROXY` so
 * Node's own `fetch` and `http` follow them too). Stdio is inherited, so the agent's ACP
 * stream never passes through here; signals are forwarded and the command's exit status
 * becomes its own. It filters nothing: the allowlist is enforced by the daemon, outside.
 */
export const NET_BRIDGE_SOURCE = `'use strict';
const net = require('node:net');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const [socket, command, ...args] = process.argv.slice(1);
const fail = (message, code) => {
  process.stderr.write('247-agent net bridge: ' + message + '\\n');
  process.exit(code);
};
if (socket === undefined || command === undefined) {
  fail('usage: <socket> <command> [args...]', 64);
}
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  const proxy = net.connect({ path: socket, allowHalfOpen: true });
  client.on('error', () => proxy.destroy());
  proxy.on('error', () => client.destroy());
  client.pipe(proxy);
  proxy.pipe(client);
});
server.on('error', (err) => fail(err.message, 70));
server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + String(server.address().port);
  const env = {
    ...process.env,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: ${JSON.stringify(NET_NO_PROXY)},
    no_proxy: ${JSON.stringify(NET_NO_PROXY)},
    NODE_USE_ENV_PROXY: '1',
  };
  const child = spawn(command, args, { env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (err) => fail(err.message, 127));
  child.on('exit', (code, signal) => {
    process.exit(code === null ? 128 + (constants.signals[signal] || 0) : code);
  });
});
`;

/** How a sandbox reaches the network, for the argv builder. */
export interface SandboxNet {
  /**
   * The daemon's proxy socket on the host: bound in at `SANDBOX_NET_SOCKET` and served to
   * the command by the bridge. Absent: no network at all.
   */
  proxySocket?: string | undefined;
  /** The Node that runs the bridge; defaults to the daemon's own (visible in the sandbox). */
  execPath?: string | undefined;
}
