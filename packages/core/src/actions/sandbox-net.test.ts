import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  matchNetRule,
  NET_BRIDGE_SOURCE,
  normaliseHost,
  parseNetRule,
  SandboxNetwork,
} from './sandbox-net.js';

describe('parseNetRule', () => {
  it('reads hosts, wildcards, addresses and ports; the port defaults to 443', () => {
    expect(parseNetRule('api.anthropic.com')).toEqual({
      host: 'api.anthropic.com',
      wildcard: false,
      port: 443,
    });
    expect(parseNetRule('*.NpmJS.org')).toEqual({ host: 'npmjs.org', wildcard: true, port: 443 });
    expect(parseNetRule('mirror.example.com:80')).toMatchObject({ port: 80 });
    expect(parseNetRule('gitea:*')).toEqual({ host: 'gitea', wildcard: false, port: '*' });
    expect(parseNetRule('10.0.0.5:8080')).toEqual({
      host: '10.0.0.5',
      wildcard: false,
      port: 8080,
    });
    expect(parseNetRule('[0:0:0:0:0:0:0:1]:8080')).toEqual({
      host: '::1',
      wildcard: false,
      port: 8080,
    });
  });

  it('refuses what is not host[:port]', () => {
    for (const bad of [
      '*',
      '*.',
      'a.*.com',
      '*example.com',
      'https://api.anthropic.com',
      'api.anthropic.com/v1',
      'host:0',
      'host:65536',
      'host:http',
      '::1',
      '[nope]:80',
      'a b',
      '-x.com',
      'x..com',
      'x.com.',
      '*.*.com',
    ]) {
      expect(() => parseNetRule(bad), bad).toThrow();
    }
    // `isIPv6` takes a zone id, the URL parser that canonicalises the address does not.
    expect(() => parseNetRule('[fe80::1%eth0]:443')).toThrow(/not an IPv6 address/);
  });
});

describe('matchNetRule', () => {
  const rules = [
    'api.anthropic.com',
    '*.npmjs.org',
    'registry.npmjs.org:*',
    'mirror.example.com:80',
    '10.0.0.5:8080',
    '[::1]:8080',
  ].map(parseNetRule);
  const allowed = (host: string, port: number): boolean =>
    matchNetRule(rules, host, port) !== undefined;

  it('matches a named host on its port only, whatever the case or a trailing dot', () => {
    expect(allowed('api.anthropic.com', 443)).toBe(true);
    expect(allowed('API.Anthropic.com.', 443)).toBe(true);
    expect(allowed('api.anthropic.com', 80)).toBe(false);
    expect(allowed('anthropic.com', 443)).toBe(false);
    expect(allowed('evil-api.anthropic.com', 443)).toBe(false);
    expect(allowed('api.anthropic.com.evil.test', 443)).toBe(false);
    expect(allowed('mirror.example.com', 80)).toBe(true);
    expect(allowed('mirror.example.com', 443)).toBe(false);
  });

  it('matches every name below a wildcard, not the suffix itself', () => {
    expect(allowed('www.npmjs.org', 443)).toBe(true);
    expect(allowed('a.b.npmjs.org', 443)).toBe(true);
    expect(allowed('npmjs.org', 443)).toBe(false);
    expect(allowed('evilnpmjs.org', 443)).toBe(false);
    expect(allowed('www.npmjs.org', 8443)).toBe(false);
  });

  it('prefers the rule that names the host over a wildcard that covers it', () => {
    expect(matchNetRule(rules, 'registry.npmjs.org', 443)).toMatchObject({ wildcard: false });
    expect(matchNetRule(rules, 'registry.npmjs.org', 8443)).toMatchObject({ wildcard: false });
    expect(matchNetRule(rules, 'www.npmjs.org', 443)).toMatchObject({ wildcard: true });
  });

  it('matches addresses only when listed, in any spelling of an IPv6 one', () => {
    expect(allowed('10.0.0.5', 8080)).toBe(true);
    expect(allowed('10.0.0.6', 8080)).toBe(false);
    expect(allowed('[::1]', 8080)).toBe(true);
    expect(allowed('0:0:0:0:0:0:0:1', 8080)).toBe(true);
    expect(allowed('127.0.0.1', 443)).toBe(false);
    // A wildcard covers names: an address that happens to end like one is not a name.
    expect(matchNetRule([parseNetRule('*.0.1')], '127.0.0.1', 443)).toBeUndefined();
    expect(matchNetRule([parseNetRule('*.0.1')], 'x.0.1', 443)).toBeDefined();
    expect(normaliseHost('[::FFFF:1.2.3.4]')).toBe('::ffff:102:304');
  });

  it('never throws on a host and keeps a wildcard to what is spelled like a hostname', () => {
    // What a sandboxed program sends reaches these as it is.
    expect(normaliseHost('[fe80::1%eth0]')).toBe('fe80::1%eth0');
    expect(allowed('[fe80::1%eth0]', 443)).toBe(false);
    for (const host of [
      'evil.test/x.npmjs.org',
      'evil.test#.npmjs.org',
      '.npmjs.org',
      'x..npmjs.org',
      '*.npmjs.org',
    ]) {
      expect(allowed(host, 443), host).toBe(false);
    }
  });
});

describe('SandboxNetwork', () => {
  it('accepts a list of entries, an empty one included, and names a bad entry', () => {
    expect(SandboxNetwork.parse({ allow: [] })).toEqual({ allow: [] });
    expect(SandboxNetwork.parse({ allow: ['api.anthropic.com', '*.npmjs.org:443'] })).toEqual({
      allow: ['api.anthropic.com', '*.npmjs.org:443'],
    });
    const bad = SandboxNetwork.safeParse({ allow: ['api.anthropic.com', 'https://x.test'] });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ['allow', 1] });
    expect(bad.error?.issues[0]?.message).toContain('is not host[:port]');
    expect(SandboxNetwork.safeParse({}).success).toBe(false);
    expect(SandboxNetwork.safeParse({ allow: [], deny: [] }).success).toBe(false);
  });
});

describe('the net bridge', () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oa-bridge-'));
  });
  afterEach(async () => {
    const open = server;
    server = undefined;
    if (open !== undefined) {
      await new Promise((r) => open.close(r));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs `node -e <bridge> -- <socket> node -e <child>`; resolves with the child's output. */
  const bridge = (
    socket: string,
    child: string,
    args: string[] = [],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((done) => {
      const p = spawn(
        process.execPath,
        ['-e', NET_BRIDGE_SOURCE, '--', socket, process.execPath, '-e', child, '--', ...args],
        { env: { PATH: process.env.PATH ?? '', HTTPS_PROXY: 'http://stale:1', KEEP: 'kept' } },
      );
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      p.stdin.end('from stdin');
      p.on('exit', (code) => {
        done({ code, stdout, stderr });
      });
    });

  it('runs the command with the proxy variables, its own stdio, arguments and exit status', async () => {
    const out = await bridge(
      join(dir, 'unused.sock'),
      `let input = '';
       process.stdin.on('data', (c) => (input += c)).on('end', () => {
         const e = process.env;
         console.log(JSON.stringify({ input, args: process.argv.slice(1), env: e }));
         process.exit(7);
       });`,
      ['-y', '--flag'],
    );
    expect(out.code).toBe(7);
    const seen = JSON.parse(out.stdout) as {
      input: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(seen.input).toBe('from stdin');
    expect(seen.args).toEqual(['-y', '--flag']);
    const proxy = seen.env.HTTPS_PROXY ?? '';
    expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.env).toMatchObject({
      HTTP_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      NODE_USE_ENV_PROXY: '1',
      KEEP: 'kept',
    });
  });

  it('pipes a connection to its port through the socket, both ways, until either side ends', async () => {
    const socket = join(dir, 'proxy.sock');
    server = createServer({ allowHalfOpen: true }, (sock) => {
      let got = '';
      sock.on('data', (c: Buffer) => (got += c.toString()));
      // Answers only once the client has finished sending: the half-close must travel.
      sock.on('end', () => sock.end(`echo:${got}`));
    });
    await new Promise<void>((r) => server?.listen(socket, r));
    const out = await bridge(
      socket,
      `const net = require('node:net');
       const { port } = new URL(process.env.HTTP_PROXY);
       const sock = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => sock.end('hello'));
       let got = '';
       sock.on('data', (c) => (got += c)).on('end', () => { console.log(got); process.exit(0); });`,
    );
    expect(out).toMatchObject({ code: 0, stdout: 'echo:hello\n' });
  });

  it('says so and exits when the command cannot be started', async () => {
    const out = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const p = spawn(process.execPath, [
        '-e',
        NET_BRIDGE_SOURCE,
        '--',
        join(dir, 'x.sock'),
        '/nonexistent/agent',
      ]);
      let stderr = '';
      p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      p.on('exit', (code) => {
        done({ code, stderr });
      });
    });
    expect(out.code).toBe(127);
    expect(out.stderr).toContain('247-agent net bridge:');
  });
});
