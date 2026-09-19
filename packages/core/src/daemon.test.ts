import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient, ApiConnectionError, ApiError } from './api/client.js';
import { AgentConfigError, startDaemon, type Daemon } from './daemon.js';
import { createLogger } from './log.js';

const TASKS = `tasks:
  - name: ok
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["true"] }
  - name: bad
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["false"] }
  - name: on_ping
    trigger: { kind: event, type: ping, filter: "payload.n > \`1\`" }
    action: { kind: shell, cmd: ["true"] }
`;

let dir: string;
let daemon: Daemon;
let api: ApiClient;
let lines: Record<string, unknown>[];

const log = () =>
  createLogger({
    level: 'debug',
    sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });

function raw(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: daemon.config.socket, method, path }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oa-daemon-'));
  writeFileSync(join(dir, 'tasks.yaml'), TASKS);
  writeFileSync(
    join(dir, 'agent.yaml'),
    'db: state.db\nsocket: core.sock\nlog: { level: debug }\n',
  );
  lines = [];
  daemon = await startDaemon({ configFile: join(dir, 'agent.yaml'), log: log() });
  api = new ApiClient({ socketPath: daemon.config.socket });
});

afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function settled(id: string) {
  await daemon.core.executor.idle();
  return api.getRun(id);
}

describe('startDaemon', () => {
  it('resolves paths from agent.yaml, opens the store and listens on the socket', async () => {
    expect(daemon.config.db).toBe(join(dir, 'state.db'));
    expect(existsSync(daemon.config.socket)).toBe(true);
    const health = await api.health();
    expect(health).toMatchObject({
      ok: true,
      pid: process.pid,
      config_file: join(dir, 'agent.yaml'),
      tasks: 3,
      runs: { pending: 0, in_flight: 0 },
    });
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['core.started', 'api.listening', 'daemon.started']),
    );
  });

  it('refuses a bad agent file and a bad tasks file without leaving anything open', async () => {
    writeFileSync(join(dir, 'broken.yaml'), 'workers: many\n');
    await expect(
      startDaemon({ configFile: join(dir, 'broken.yaml'), log: log() }),
    ).rejects.toBeInstanceOf(AgentConfigError);

    writeFileSync(join(dir, 'tasks2.yaml'), 'tasks: []\n');
    writeFileSync(join(dir, 'agent2.yaml'), 'db: two.db\nsocket: two.sock\ntasks: tasks2.yaml\n');
    await expect(startDaemon({ configFile: join(dir, 'agent2.yaml'), log: log() })).rejects.toThrow(
      /invalid config/,
    );
    expect(existsSync(join(dir, 'two.sock'))).toBe(false);
  });

  it('refuses to start while another daemon holds the socket, but replaces a stale one', async () => {
    writeFileSync(join(dir, 'agent2.yaml'), 'db: two.db\nsocket: core.sock\n');
    await expect(startDaemon({ configFile: join(dir, 'agent2.yaml'), log: log() })).rejects.toThrow(
      /another daemon is listening/,
    );

    const stale = join(dir, 'stale.sock');
    const holder: Server = createServer();
    await new Promise<void>((resolve) => holder.listen(stale, resolve));
    holder.unref();
    await new Promise<void>((resolve) => {
      // Node unlinks the file on close; recreate it so it is a dead socket.
      holder.close(() => {
        resolve();
      });
    });
    writeFileSync(stale, '');
    writeFileSync(join(dir, 'agent3.yaml'), 'db: three.db\nsocket: stale.sock\n');
    const second = await startDaemon({ configFile: join(dir, 'agent3.yaml'), log: log() });
    try {
      expect(lines.some((l) => l.msg === 'api.stale_socket_removed')).toBe(true);
      await expect(new ApiClient({ socketPath: stale }).health()).resolves.toMatchObject({
        ok: true,
      });
    } finally {
      await second.stop();
    }
  });

  it('removes the socket on stop and the client reports the daemon as unreachable', async () => {
    const socket = daemon.config.socket;
    await daemon.stop();
    expect(existsSync(socket)).toBe(false);
    await expect(api.health()).rejects.toBeInstanceOf(ApiConnectionError);
  });

  it('reloads the tasks file and keeps the old one when the new one is invalid', () => {
    writeFileSync(join(dir, 'tasks.yaml'), 'tasks: [');
    expect(daemon.reload().ok).toBe(false);
    expect(daemon.core.config().tasks).toHaveLength(3);
    writeFileSync(join(dir, 'tasks.yaml'), TASKS.split('  - name: bad')[0] ?? '');
    expect(daemon.reload().ok).toBe(true);
    expect(daemon.core.config().tasks.map((t) => t.name)).toEqual(['ok']);
  });
});

describe('POST /v1/events', () => {
  it('publishes, deduplicates and dispatches to matching tasks', async () => {
    const first = await api.emit({
      type: 'ping',
      source: 'test',
      dedup_key: 'p1',
      payload: { n: 2 },
    });
    expect(first.status).toBe('inserted');
    if (first.status !== 'inserted') {
      return;
    }
    expect(first.event).toMatchObject({
      type: 'ping',
      source: 'test',
      depth: 0,
      payload: { n: 2 },
    });
    await expect(api.getEvent(first.event.id)).resolves.toEqual(first.event);

    const dup = await api.emit({
      type: 'ping',
      source: 'test',
      dedup_key: 'p1',
      payload: { n: 3 },
    });
    expect(dup).toEqual({ status: 'duplicate', dedup_key: 'p1' });

    const filtered = await api.emit({ type: 'ping', source: 'test', payload: { n: 0 } });
    expect(filtered.status).toBe('inserted');

    await daemon.core.executor.idle();
    const runs = await api.listRuns({ task: 'on_ping' });
    expect(runs.map((r) => [r.event_id, r.status])).toEqual([[first.event.id, 'succeeded']]);
  });

  it('threads correlation and depth through parent_id', async () => {
    const root = await api.emit({ type: 'a.b', source: 'test' });
    if (root.status !== 'inserted') {
      throw new Error('unexpected');
    }
    const child = await api.emit({ type: 'a.c', source: 'test', parent_id: root.event.id });
    expect(child.status === 'inserted' && child.event).toMatchObject({
      correlation_id: root.event.correlation_id,
      parent_id: root.event.id,
      depth: 1,
    });
    await expect(
      api.emit({ type: 'a.c', source: 'test', parent_id: 'evt_nope' }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/unknown parent/) as unknown,
    });
  });

  it('rejects malformed events with 400 and per-field issues', async () => {
    const err = await api.emit({ type: 'Bad Type', source: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).issues.map((i) => i.path)).toEqual(['source']);
    await expect(api.emit({ type: 'bad type', source: 'x' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/invalid event type/) as unknown,
    });
    await expect(raw('POST', '/v1/events', '{not json')).resolves.toMatchObject({ status: 400 });
    await expect(
      raw('POST', '/v1/events', JSON.stringify({ type: 'x.y', extra: 1 })),
    ).resolves.toMatchObject({ status: 400 });
  });
});

describe('POST /v1/runs and GET /v1/runs', () => {
  it('queues a manual run with the given input event and runs it to completion', async () => {
    const { event_id, run } = await api.run('ok', {
      type: 'custom.input',
      payload: { x: 1 },
      correlation_id: 'cor_test',
    });
    // The executor may already have picked the run up before the response was built.
    expect(run).toMatchObject({ task: 'ok', event_id, correlation_id: 'cor_test' });
    expect(['queued', 'running']).toContain(run.status);
    await expect(api.getEvent(event_id)).resolves.toMatchObject({
      type: 'manual.run',
      source: 'manual',
      payload: { task: 'ok', event: { type: 'custom.input', payload: { x: 1 } } },
    });
    expect((await settled(run.id)).status).toBe('succeeded');
  });

  it('reports a failed run with its error', async () => {
    const { run } = await api.run('bad');
    const final = await settled(run.id);
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/exit|false|1/);
  });

  it('lists newest first with status/task/limit filters', async () => {
    const a = await api.run('ok');
    const b = await api.run('bad');
    await daemon.core.executor.idle();
    expect((await api.listRuns()).map((r) => r.id)).toEqual([b.run.id, a.run.id]);
    expect((await api.listRuns({ status: 'failed' })).map((r) => r.task)).toEqual(['bad']);
    expect((await api.listRuns({ task: 'ok' })).map((r) => r.id)).toEqual([a.run.id]);
    expect(await api.listRuns({ limit: 1 })).toHaveLength(1);
    await expect(api.listRuns({ status: 'nope' as 'failed' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('answers 404 for unknown tasks, runs, events and routes, 405 for wrong methods', async () => {
    await expect(api.run('nope')).rejects.toMatchObject({ status: 404 });
    await expect(api.getRun('run_nope')).rejects.toMatchObject({ status: 404 });
    await expect(api.getEvent('evt_nope')).rejects.toMatchObject({ status: 404 });
    await expect(raw('GET', '/v1/nothing')).resolves.toMatchObject({ status: 404 });
    await expect(raw('DELETE', '/v1/health')).resolves.toMatchObject({ status: 405 });
    await expect(raw('GET', '/v1/events')).resolves.toMatchObject({ status: 405 });
  });

  it('rejects oversized bodies', async () => {
    const big = JSON.stringify({ type: 'x.y', payload: 'a'.repeat(2 * 1024 * 1024) });
    const res = await raw('POST', '/v1/events', big).catch(() => ({ status: 413, body: null }));
    expect(res.status).toBe(413);
  });
});
