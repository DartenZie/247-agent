import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CoreApiError, type EmitInput, type EmitResult } from '@247-agent/connector-sdk';

import { parseConfig, type WebhookConfig } from './config.js';
import { parseBody, startServer } from './server.js';

const SECRET = 'gh-secret';

/** The core's event endpoint: records events and drops a repeated `dedup_key`. */
class FakeCore {
  readonly events: EmitInput[] = [];
  failWith: Error | undefined;
  private readonly keys = new Set<string>();

  emitEvent(input: EmitInput): Promise<EmitResult> {
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    if (input.dedup_key !== undefined) {
      if (this.keys.has(input.dedup_key)) {
        return Promise.resolve({ status: 'duplicate', dedup_key: input.dedup_key });
      }
      this.keys.add(input.dedup_key);
    }
    this.events.push(input);
    const id = `evt_${String(this.events.length)}`;
    return Promise.resolve({ status: 'inserted', event: { id, correlation_id: id } });
  }
}

function config(overrides: Record<string, unknown> = {}): WebhookConfig {
  return parseConfig({
    listen: { host: '127.0.0.1', port: 0 },
    routes: [
      {
        path: '/hooks/github',
        event: 'github',
        type_header: 'X-GitHub-Event',
        dedup_header: 'X-GitHub-Delivery',
        verify: { kind: 'github', secret: SECRET },
      },
      {
        path: '/hooks/deploy',
        event: 'deploy.requested',
        verify: { kind: 'token', token: 'tok' },
        methods: ['POST', 'PUT'],
      },
      { path: '/open', event: 'open.ping', verify: { kind: 'none' } },
    ],
    ...overrides,
  });
}

let servers: Server[] = [];
const logs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
  logs.length = 0;
});

async function start(core: FakeCore, cfg = config()): Promise<string> {
  const { server, address } = await startServer({
    config: cfg,
    core,
    name: 'webhook',
    log: (l) => logs.push(l),
    now: () => new Date('2026-09-30T12:00:00Z'),
  });
  servers.push(server);
  return address;
}

function github(body: string, opts: { event?: string; delivery?: string; secret?: string } = {}) {
  const sig = createHmac('sha256', opts.secret ?? SECRET)
    .update(body)
    .digest('hex');
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': opts.event ?? 'push',
      'x-github-delivery': opts.delivery ?? 'd-1',
      'x-hub-signature-256': `sha256=${sig}`,
    },
    body,
  };
}

describe('webhook server', () => {
  it('emits a verified GitHub delivery as github.<event>, without the signature', async () => {
    const core = new FakeCore();
    const base = await start(core);
    const res = await fetch(`${base}/hooks/github?x=1&x=2`, github('{"ref":"refs/heads/main"}'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, event_id: 'evt_1' });
    expect(core.events).toHaveLength(1);
    const [event] = core.events;
    expect(event).toMatchObject({
      type: 'github.push',
      dedup_key: 'webhook:hooks-github:d-1',
      payload: {
        route: 'hooks-github',
        method: 'POST',
        path: '/hooks/github',
        query: { x: ['1', '2'] },
        content_type: 'application/json',
        body_format: 'json',
        body: { ref: 'refs/heads/main' },
        remote: '127.0.0.1',
        received_at: '2026-09-30T12:00:00.000Z',
      },
    });
    const headers = (event?.payload as { headers: Record<string, string> }).headers;
    expect(headers['x-github-event']).toBe('push');
    expect(headers['x-hub-signature-256']).toBeUndefined();
  });

  it('answers a redelivery with 200 duplicate and emits nothing', async () => {
    const core = new FakeCore();
    const base = await start(core);
    expect((await fetch(`${base}/hooks/github`, github('{}'))).status).toBe(202);
    const again = await fetch(`${base}/hooks/github`, github('{}'));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(core.events).toHaveLength(1);
  });

  it('rejects a bad signature with 401 and logs why', async () => {
    const core = new FakeCore();
    const base = await start(core);
    const res = await fetch(`${base}/hooks/github`, github('{}', { secret: 'wrong' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    expect(core.events).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/rejected POST \/hooks\/github .*signature mismatch/);
  });

  it('folds the type header into one segment and requires it', async () => {
    const core = new FakeCore();
    const base = await start(core);
    await fetch(`${base}/hooks/github`, github('{}', { event: 'Pull.Request Review' }));
    expect(core.events[0]?.type).toBe('github.pull_request_review');
    const req = github('{}', { delivery: 'd-2' });
    const { 'x-github-event': _, ...headers } = req.headers;
    const res = await fetch(`${base}/hooks/github`, { ...req, headers });
    expect(res.status).toBe(400);
  });

  it('routes by path and method, and drops credential headers', async () => {
    const core = new FakeCore();
    const base = await start(core);
    expect((await fetch(`${base}/nope`, { method: 'POST' })).status).toBe(404);
    const get = await fetch(`${base}/hooks/deploy`, { headers: { authorization: 'Bearer tok' } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, PUT');
    const res = await fetch(`${base}/hooks/deploy`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', cookie: 'a=b', 'x-extra': 'kept' },
      body: 'env=prod&force=1',
    });
    expect(res.status).toBe(202);
    const payload = core.events[0]?.payload as Record<string, unknown>;
    expect(core.events[0]?.type).toBe('deploy.requested');
    expect(core.events[0]?.dedup_key).toBeUndefined();
    expect(payload.headers).not.toHaveProperty('authorization');
    expect(payload.headers).not.toHaveProperty('cookie');
    expect(payload.headers).toHaveProperty('x-extra', 'kept');
    expect(payload.body_format).toBe('text');
  });

  it('refuses bodies over max_body with 413', async () => {
    const core = new FakeCore();
    const base = await start(core, config({ max_body: 10 }));
    const res = await fetch(`${base}/open`, { method: 'POST', body: 'x'.repeat(11) });
    expect(res.status).toBe(413);
    // Without a content-length, the limit applies while streaming.
    const streamed = await rawPost(base, '/open', 'y'.repeat(50));
    expect(streamed).toBe(413);
    expect(core.events).toHaveLength(0);
  });

  it('answers 400 for invalid JSON', async () => {
    const core = new FakeCore();
    const base = await start(core);
    const res = await fetch(`${base}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
  });

  it('answers 503 with retry-after when the core is unreachable, 422 when it refuses', async () => {
    const core = new FakeCore();
    const base = await start(core);
    core.failWith = new Error('connect ENOENT /run/247-agent/core.sock');
    const down = await fetch(`${base}/open`, { method: 'POST', body: 'hi' });
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('30');
    core.failWith = new CoreApiError(400, 'payload too large');
    expect((await fetch(`${base}/open`, { method: 'POST', body: 'hi' })).status).toBe(422);
  });

  it('serves /healthz', async () => {
    const base = await start(new FakeCore());
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('listens on a Unix socket with the configured mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-webhook-'));
    try {
      const path = join(dir, 'http.sock');
      const core = new FakeCore();
      const address = await start(core, config({ listen: { path, mode: '0600' } }));
      expect(address).toBe(`unix:${path}`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ socketPath: path, method: 'POST', path: '/open' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end('hello');
      });
      expect(status).toBe(202);
      expect(core.events[0]?.payload).toMatchObject({ body: 'hello', remote: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseBody', () => {
  it('parses json, form, text and bytes', () => {
    expect(parseBody(Buffer.from('{"a":1}'), 'application/vnd.x+json; charset=utf-8')).toEqual({
      format: 'json',
      body: { a: 1 },
    });
    expect(parseBody(Buffer.from('a=1&a=2&b=3'), 'application/x-www-form-urlencoded')).toEqual({
      format: 'form',
      body: { a: ['1', '2'], b: '3' },
    });
    expect(parseBody(Buffer.from('plain'), null)).toEqual({ format: 'text', body: 'plain' });
    expect(parseBody(Buffer.from([0xff, 0xfe]), 'application/octet-stream')).toEqual({
      format: 'base64',
      body: '//4=',
    });
    expect(parseBody(Buffer.alloc(0), 'application/json')).toEqual({ format: 'empty', body: null });
  });
});

/** A chunked POST (no content-length), to exercise the streaming limit. */
function rawPost(base: string, path: string, body: string): Promise<number> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, method: 'POST', path: url.pathname },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.write(body.slice(0, 5));
    req.end(body.slice(5));
  });
}
