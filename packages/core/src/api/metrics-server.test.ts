import { createServer, type Server } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../log.js';
import { Metrics } from '../metrics.js';
import { createMetricsServer, type MetricsServer } from './metrics-server.js';

let lines: Record<string, unknown>[];
let metrics: Metrics;
let server: MetricsServer;

beforeEach(() => {
  lines = [];
  metrics = new Metrics();
  server = createMetricsServer({
    metrics,
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
  });
});

afterEach(async () => {
  await server.close();
});

const LOOPBACK = { host: '127.0.0.1', port: 0 };

function url(path: string): string {
  const a = server.address();
  if (a === undefined) {
    throw new Error('not listening');
  }
  return `http://127.0.0.1:${String(a.port)}${path}`;
}

function occupy(): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
}

describe('createMetricsServer (#59)', () => {
  it('listens on nothing until configured', async () => {
    await server.configure(undefined);
    expect(server.address()).toBeUndefined();
  });

  it('serves the same Prometheus text as the socket on GET /metrics and nothing else', async () => {
    await server.configure(LOOPBACK);
    metrics.configReloads.inc({ result: 'ok' });
    const res = await fetch(url('/metrics'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('oa_config_reloads_total{result="ok"} 1');
    expect(text).toBe(metrics.render());

    expect((await fetch(url('/metrics?x=1'))).status).toBe(200);
    expect((await fetch(url('/metrics'), { method: 'HEAD' })).status).toBe(200);
    for (const path of ['/', '/v1/health', '/v1/runs', '/v1/state/x', '/metrics/']) {
      expect((await fetch(url(path))).status, path).toBe(404);
    }
    const post = await fetch(url('/metrics'), { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(lines.map((l) => l.msg)).toContain('metrics.listening');
  });

  it('keeps the listener for the same address, moves it for a new one and stops it for none', async () => {
    await server.configure(LOOPBACK);
    const first = server.address();
    await server.configure({ ...LOOPBACK });
    expect(server.address()).toEqual(first);

    const taken = await occupy();
    const port = (taken.address() as { port: number }).port;
    await new Promise<void>((resolve) =>
      taken.close(() => {
        resolve();
      }),
    );
    await server.configure({ host: '127.0.0.1', port });
    expect(server.address()?.port).toBe(port);
    await expect(fetch(`http://127.0.0.1:${String(first?.port)}/metrics`)).rejects.toThrow();
    expect((await fetch(url('/metrics'))).status).toBe(200);

    await server.configure(undefined);
    expect(server.address()).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${String(port)}/metrics`)).rejects.toThrow();
    expect(lines.map((l) => l.msg)).toContain('metrics.closed');
  });

  it('stays closed after close(), even for a configure queued behind it', async () => {
    await server.configure(LOOPBACK);
    const closing = server.close();
    const late = server.configure(LOOPBACK);
    await closing;
    await late;
    expect(server.address()).toBeUndefined();
    await server.configure(LOOPBACK);
    expect(server.address()).toBeUndefined();
  });

  it('moves to another host on the same port', async () => {
    await server.configure(LOOPBACK);
    const port = server.address()?.port;
    await server.configure({ host: '0.0.0.0', port: port ?? 0 });
    expect(server.address()).toEqual({ host: '0.0.0.0', port });
    expect((await fetch(url('/metrics'))).status).toBe(200);
  });

  it('keeps the old listener when a host on the same port cannot be bound', async () => {
    await server.configure(LOOPBACK);
    const before = server.address();
    // TEST-NET-1: never a local address, so the bind fails with EADDRNOTAVAIL.
    await expect(server.configure({ host: '192.0.2.55', port: before?.port ?? 0 })).rejects.toThrow(
      /cannot listen for metrics on 192\.0\.2\.55/,
    );
    expect(server.address()).toEqual(before);
    expect(lines.map((l) => l.msg)).not.toContain('metrics.closed');
  });

  it('rejects an address in use and keeps serving on the previous one', async () => {
    await server.configure(LOOPBACK);
    const before = server.address();
    const taken = await occupy();
    const port = (taken.address() as { port: number }).port;
    try {
      await expect(server.configure({ host: '127.0.0.1', port })).rejects.toThrow(
        /cannot listen for metrics on 127\.0\.0\.1:\d+/,
      );
      expect(server.address()).toEqual(before);
      expect((await fetch(url('/metrics'))).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) =>
        taken.close(() => {
          resolve();
        }),
      );
    }
  });
});
