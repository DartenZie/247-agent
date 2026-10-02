import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo, LookupFunction, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa, execaSync } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSandboxArgv, Sandbox, sandboxHost } from '../actions/sandbox.js';
import { createLogger } from '../log.js';
import {
  isNonPublicAddress,
  openNetProxy,
  publicOnly,
  type NetProxy,
  type NetProxyResult,
} from './net-proxy.js';

/** Test names, all on this machine: nothing here touches the network. */
const HOSTS: Record<string, string> = {
  'api.test': '127.0.0.1',
  'www.wild.test': '127.0.0.1',
};

const lookup: LookupFunction = (hostname, options, callback) => {
  const address = HOSTS[hostname];
  if (address === undefined) {
    const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    callback(err, '');
  } else if (options.all === true) {
    callback(null, [{ address, family: 4 }]);
  } else {
    callback(null, address, 4);
  }
};

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

let dir: string;
let socket: string;
let proxy: NetProxy | undefined;
let origin: Server;
let port: number;
let lines: Record<string, unknown>[];
let results: NetProxyResult[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oa-net-'));
  socket = join(dir, 'proxy.sock');
  lines = [];
  results = [];
  // The origin echoes what reached it, so a test sees what the proxy forwarded.
  origin = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      res.writeHead(req.url === '/missing' ? 404 : 200, {
        'content-type': 'application/json',
        'x-origin': 'yes',
        'set-cookie': ['a=1', 'b=2'],
      });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  port = (origin.address() as AddressInfo).port;
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  origin.closeAllConnections();
  await new Promise((r) => origin.close(r));
  rmSync(dir, { recursive: true, force: true });
});

async function open(allow: string[]): Promise<NetProxy> {
  proxy = await openNetProxy({
    allow,
    socket,
    lookup,
    connectTimeoutMs: 2000,
    onRequest: (r) => results.push(r),
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
  });
  return proxy;
}

/** A plain request to the proxy, as a client configured with `HTTP_PROXY` sends it. */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString()));
      res.on('end', () => {
        done({ status: res.statusCode ?? 0, headers: res.headers, body: text });
      });
    });
    req.on('error', fail);
    req.end(body);
  });
}

/** `CONNECT authority`: the status and, when the tunnel opened, its socket. */
function tunnel(authority: string): Promise<{ status: number; sock: Socket; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, method: 'CONNECT', path: authority });
    req.on('connect', (res, sock, head) => {
      if (res.statusCode === 200) {
        done({ status: 200, sock, body: '' });
        return;
      }
      let body = head.toString();
      sock.on('data', (c: Buffer) => (body += c.toString()));
      sock.on('end', () => {
        done({ status: res.statusCode ?? 0, sock, body });
      });
      sock.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

/** One HTTP exchange over an open tunnel, the way TLS would run inside it. */
function over(sock: Socket, path: string): Promise<string> {
  return new Promise((done, fail) => {
    let text = '';
    sock.on('data', (c: Buffer) => (text += c.toString()));
    sock.on('end', () => {
      done(text);
    });
    sock.on('error', fail);
    sock.write(`GET ${path} HTTP/1.1\r\nHost: api.test\r\nConnection: close\r\n\r\n`);
  });
}

const logged = (msg: string): Record<string, unknown>[] => lines.filter((l) => l.msg === msg);

describe('openNetProxy', () => {
  it('listens on a socket only its owner can use and removes it on close', async () => {
    const p = await open(['api.test']);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(logged('sandbox.net_proxy')).toEqual([
      expect.objectContaining({ socket, allow: 'api.test' }),
    ]);
    await p.close();
    await p.close();
    expect(existsSync(socket)).toBe(false);
  });

  it('refuses a socket path the platform cannot bind', async () => {
    await expect(
      openNetProxy({
        allow: [],
        socket: join(dir, 'x'.repeat(120)),
        log: createLogger({ sink: () => undefined }),
      }),
    ).rejects.toThrow(/longer than/);
  });

  it('tunnels CONNECT to an allowed host and port, bytes untouched both ways', async () => {
    await open([`api.test:${String(port)}`]);
    const t = await tunnel(`api.test:${String(port)}`);
    expect(t.status).toBe(200);
    const text = await over(t.sock, '/v1/messages?x=1');
    expect(text).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(text).toContain('"url":"/v1/messages?x=1"');
    expect(results).toEqual(['allowed']);
    expect(logged('sandbox.net_connect')).toEqual([
      expect.objectContaining({ level: 'debug', host: 'api.test', port }),
    ]);
  });

  it('refuses CONNECT to a host or a port that is not listed, and says so once at warn', async () => {
    await open([`api.test:${String(port)}`]);
    const other = await tunnel(`evil.test:${String(port)}`);
    expect(other.status).toBe(403);
    expect(other.body).toBe(
      `247-agent: evil.test:${String(port)} is not in this sandbox's network allowlist\n`,
    );
    expect((await tunnel('api.test:443')).status).toBe(403);
    expect((await tunnel(`127.0.0.1:${String(port)}`)).status).toBe(403);
    expect((await tunnel(`evil.test:${String(port)}`)).status).toBe(403);
    expect(results).toEqual(['denied', 'denied', 'denied', 'denied']);
    const denied = logged('sandbox.net_denied');
    expect(denied.map((l) => [l.level, l.host, l.port])).toEqual([
      ['warn', 'evil.test', port],
      ['warn', 'api.test', 443],
      ['warn', '127.0.0.1', port],
      ['debug', 'evil.test', port],
    ]);
    expect(denied[0]).toMatchObject({ reason: 'not in the allowlist' });
  });

  it('keeps a wildcard away from a name that resolves to a non-public address', async () => {
    await open([`*.wild.test:${String(port)}`]);
    const t = await tunnel(`www.wild.test:${String(port)}`);
    expect(t.status).toBe(403);
    expect(t.body).toContain('www.wild.test resolves to 127.0.0.1');
    const plain = await send('GET', `http://www.wild.test:${String(port)}/x`);
    expect(plain.status).toBe(403);
    expect(results).toEqual(['denied', 'denied']);
    expect(logged('sandbox.net_denied')[0]).toMatchObject({
      level: 'warn',
      host: 'www.wild.test',
      reason: expect.stringContaining('which a wildcard entry does not reach') as string,
    });
  });

  it('lets an entry that names the host or the address reach this machine', async () => {
    await open([`127.0.0.1:${String(port)}`, `www.wild.test:${String(port)}`, '*.wild.test:*']);
    expect((await tunnel(`127.0.0.1:${String(port)}`)).status).toBe(200);
    expect((await tunnel(`www.wild.test:${String(port)}`)).status).toBe(200);
  });

  it('answers 502 when an allowed host cannot be reached or resolved', async () => {
    await open(['api.test:1', 'gone.test']);
    const refused = await tunnel('api.test:1');
    expect(refused.status).toBe(502);
    expect(refused.body).toContain('cannot reach api.test:1');
    const unknown = await tunnel('gone.test:443');
    expect(unknown.status).toBe(502);
    expect(unknown.body).toContain('ENOTFOUND');
    expect(results).toEqual(['failed', 'failed']);
    expect(logged('sandbox.net_failed')).toHaveLength(2);
  });

  it('forwards a plain http request in origin form, without the hop-by-hop headers', async () => {
    await open([`api.test:${String(port)}`]);
    const res = await send(
      'POST',
      `http://api.test:${String(port)}/submit?a=1`,
      {
        host: 'fronted.test',
        'content-type': 'text/plain',
        'proxy-authorization': 'Basic c2VjcmV0',
        'proxy-connection': 'keep-alive',
        connection: 'x-drop-me',
        'x-drop-me': '1',
        'x-keep': 'yes',
      },
      'payload',
    );
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'x-origin': 'yes', 'set-cookie': ['a=1', 'b=2'] });
    const seen = JSON.parse(res.body) as {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(seen).toMatchObject({ method: 'POST', url: '/submit?a=1', body: 'payload' });
    // Host is the URL's, whatever the client put in the header.
    expect(seen.headers).toMatchObject({
      host: `api.test:${String(port)}`,
      'content-type': 'text/plain',
      'x-keep': 'yes',
    });
    expect(Object.keys(seen.headers)).not.toEqual(
      expect.arrayContaining(['proxy-authorization', 'proxy-connection', 'x-drop-me']),
    );
    expect((await send('GET', `http://api.test:${String(port)}/missing`)).status).toBe(404);
    expect(results).toEqual(['allowed', 'allowed']);
    expect(logged('sandbox.net_request')[0]).toMatchObject({ method: 'POST', status: 200 });
  });

  it('refuses plain http to anything else, and requests that are not for a proxy', async () => {
    await open([`api.test:${String(port)}`]);
    const denied = await send('GET', `http://evil.test:${String(port)}/`);
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('evil.test');
    // The default port of plain http is 80, which the entry does not cover.
    expect((await send('GET', 'http://api.test/')).status).toBe(403);
    expect((await send('GET', '/v1/state')).status).toBe(400);
    expect((await send('GET', 'https://api.test/')).status).toBe(400);
    expect(results).toEqual(['denied', 'denied']);
  });

  it('drops open tunnels when it closes', async () => {
    const p = await open([`api.test:${String(port)}`]);
    const t = await tunnel(`api.test:${String(port)}`);
    const gone = new Promise((r) => t.sock.on('close', r));
    await p.close();
    await gone;
    expect(t.sock.destroyed).toBe(true);
  });
});

/** bwrap that can make a network namespace here (not in a container without user namespaces). */
const hasBwrap =
  execaSync('bwrap', ['--unshare-net', '--ro-bind', '/', '/', 'true'], { reject: false })
    .exitCode === 0;

describe('behind real bubblewrap', () => {
  it.skipIf(!hasBwrap)(
    'a sandbox with no network of its own reaches an allowed host through the proxy, nothing else',
    async () => {
      await open([`api.test:${String(port)}`]);
      const work = join(dir, 'work');
      mkdirSync(work);
      const script = `
        const http = require('node:http');
        const net = require('node:net');
        const proxy = new URL(process.env.HTTP_PROXY);
        const get = (url) => new Promise((done) => {
          http.request(
            { host: proxy.hostname, port: proxy.port, path: url, headers: { host: new URL(url).host } },
            (res) => {
              let body = '';
              res.on('data', (c) => (body += c)).on('end', () => done({ status: res.statusCode, body }));
            },
          ).on('error', (e) => done({ error: e.code })).end();
        });
        const direct = new Promise((done) => {
          const s = net.connect(${String(port)}, '127.0.0.1');
          s.on('connect', () => done('connected')).on('error', (e) => done(e.code));
        });
        (async () => {
          const allowed = await get('http://api.test:${String(port)}/x');
          const denied = await get('http://evil.test:${String(port)}/');
          console.log(JSON.stringify({ direct: await direct, allowed: allowed.status, denied: denied.status }));
          process.exit(0);
        })();`;
      const [file = '', ...args] = buildSandboxArgv({
        sandbox: Sandbox.parse('bwrap'),
        cmd: [process.execPath, '-e', script],
        writable: work,
        env: {},
        host: sandboxHost({ protected: [], env: {} }),
        net: { proxySocket: socket },
      });
      const { stdout } = await execa(file, args);
      // The origin listens on the host's loopback: out of reach directly, in reach by name.
      expect(JSON.parse(stdout)).toEqual({ direct: 'ECONNREFUSED', allowed: 200, denied: 403 });
      expect(results).toEqual(['allowed', 'denied']);
    },
  );
});

describe('isNonPublicAddress', () => {
  it('knows loopback, private, link-local and reserved ranges in both families', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    for (const a of [
      '8.8.8.8',
      '172.32.0.1',
      '160.79.104.10',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isNonPublicAddress(a), a).toBe(false);
    }
  });
});

describe('publicOnly', () => {
  const resolve =
    (addresses: string[]): LookupFunction =>
    (_host, options, callback) => {
      const all = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      if (options.all === true) {
        callback(null, all);
      } else {
        callback(null, all[0]?.address ?? '', all[0]?.family);
      }
    };
  const run = (
    addresses: string[],
    all: boolean,
  ): Promise<{ err: Error | null; address: unknown }> =>
    new Promise((done) => {
      publicOnly(resolve(addresses))('x.test', { all }, (err, address) => {
        done({ err, address });
      });
    });

  it('passes public addresses and drops the others from a list', async () => {
    expect(await run(['8.8.8.8'], false)).toEqual({ err: null, address: '8.8.8.8' });
    expect(await run(['10.0.0.1', '8.8.8.8', '::1'], true)).toEqual({
      err: null,
      address: [{ address: '8.8.8.8', family: 4 }],
    });
  });

  it('fails the lookup when nothing public is left', async () => {
    expect((await run(['127.0.0.1'], false)).err?.message).toContain(
      'x.test resolves to 127.0.0.1',
    );
    expect((await run(['10.0.0.1', '::1'], true)).err?.message).toContain(
      'x.test resolves to 10.0.0.1',
    );
  });
});
