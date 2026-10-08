import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConnectors } from '../config/load.js';
import { loadAgentFile } from '../config/agent.js';
import { createLogger } from '../log.js';
import { staticSecrets } from '../secrets/secrets.js';
import {
  ConnectorHostError,
  prepareLaunch,
  startConnectorHost,
  type ConnectorHost,
} from './host.js';
import { ConnectorSupervisor } from './supervisor.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url).pathname;

let dir: string;
let configFile: string;
let hosts: ConnectorHost[];
let sup: ConnectorSupervisor | undefined;
let servers: Server[];
const hostLogs: string[] = [];

beforeEach(() => {
  // Short: Unix socket paths are limited to ~104 bytes on macOS.
  dir = mkdtempSync(join(tmpdir(), 'oa-host-'));
  configFile = join(dir, 'agent.yaml');
  hosts = [];
  servers = [];
  hostLogs.length = 0;
  writeFileSync(
    configFile,
    `db: ${dir}/state.db
socket: ${dir}/core.sock
secrets: { backend: env, prefix: OA_SECRET_ }
connectors:
  - name: fake
    exec: [node, ${FIXTURES}fake-mcp.ts]
    managed_by: systemd
    socket: ${dir}/fake.sock
    config: { token: "\${secrets.tok}" }
    env: { FAKE_EXTRA: "\${secrets.tok}-x" }
    restart: { base: 20ms, max: 100ms }
  - name: plain
    exec: [node, ${FIXTURES}fake-plain.ts]
    transport: none
    managed_by: systemd
  - name: child
    exec: [node, ${FIXTURES}fake-mcp.ts]
`,
  );
});

afterEach(async () => {
  await sup?.stop();
  sup = undefined;
  await Promise.all(hosts.map((h) => h.stop()));
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});

const env = { PATH: process.env.PATH ?? '', OA_SECRET_TOK: 'from-the-unit' };

async function host(name: string): Promise<ConnectorHost> {
  const h = await startConnectorHost({
    configFile,
    name,
    env,
    log: createLogger({ level: 'debug', sink: (l) => hostLogs.push(l) }),
    killTimeoutMs: 1000,
  });
  hosts.push(h);
  return h;
}

function supervisor(): ConnectorSupervisor {
  const agent = loadAgentFile(configFile);
  if (!agent.ok) {
    throw new Error('bad agent.yaml');
  }
  const loaded = loadConnectors(agent.config.connectorPaths, agent.config.connectors);
  sup = new ConnectorSupervisor({
    manifests: (loaded.connectors ?? []).filter((m) => m.name !== 'child'),
    socketPath: agent.config.socket,
    // The core knows no secret of a unit's connector: resolving one would throw.
    secrets: staticSecrets({}),
    log: createLogger({ level: 'error', sink: () => undefined }),
  });
  return sup;
}

const signal = (): AbortSignal => new AbortController().signal;

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A stand-in for the core's socket that accepts events. */
async function coreSocket(): Promise<string[]> {
  const received: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push(body);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'inserted', event: { id: 'evt_1', correlation_id: 'c' } }));
    });
  });
  await new Promise<void>((r) => server.listen(join(dir, 'core.sock'), r));
  servers.push(server);
  return received;
}

describe('prepareLaunch', () => {
  it("renders the environment from the unit's own secrets", () => {
    const launch = prepareLaunch({ configFile, name: 'fake', env });
    expect(launch.command).toBe('node');
    expect(launch.env).toMatchObject({
      OA_CONNECTOR_NAME: 'fake',
      OA_CORE_SOCKET: join(dir, 'core.sock'),
      OA_CONFIG_JSON: JSON.stringify({ token: 'from-the-unit' }),
      FAKE_EXTRA: 'from-the-unit-x',
    });
    expect(launch.env.OA_SECRET_TOK).toBeUndefined();
  });

  it('refuses unknown connectors, core-managed ones and missing secrets', () => {
    expect(() => prepareLaunch({ configFile, name: 'nope', env })).toThrow(
      /no connector named "nope"/,
    );
    expect(() => prepareLaunch({ configFile, name: 'child', env })).toThrow(
      /spawned by the daemon; set managed_by: systemd/,
    );
    expect(() => prepareLaunch({ configFile, name: 'fake', env: { PATH: '' } })).toThrow(
      ConnectorHostError,
    );
    expect(() => prepareLaunch({ configFile, name: 'fake', env: { PATH: '' } })).toThrow(
      /secret "tok" is not set/,
    );
  });
});

describe('a unit with ops', () => {
  it('serves the connector on its socket; the core connects instead of spawning', async () => {
    const h = await host('fake');
    expect(h.socket).toBe(join(dir, 'fake.sock'));
    const s = supervisor();
    await s.start();
    expect(s.status().find((c) => c.name === 'fake')).toMatchObject({
      state: 'up',
      managed_by: 'systemd',
      pid: null,
    });
    await expect(s.call('fake', 'env', {}, { signal: signal() })).resolves.toEqual({
      name: 'fake',
      socket: join(dir, 'core.sock'),
      config: { token: 'from-the-unit' },
      extra: 'from-the-unit-x',
    });
    await expect(
      s.call('fake', 'echo', { value: [1, 'a'] }, { signal: signal() }),
    ).resolves.toEqual({
      echoed: [1, 'a'],
    });
  });

  it('respawns the connector when the core reconnects (oa connector restart)', async () => {
    await host('fake');
    const s = supervisor();
    await s.start();
    const started = (): number =>
      hostLogs.filter((l) => l.includes('connector_host.session_started')).length;
    expect(started()).toBe(1);
    const status = await s.restart('fake');
    expect(status.state).toBe('up');
    await until(() => started() === 2);
    await expect(s.call('fake', 'echo', { value: 1 }, { signal: signal() })).resolves.toEqual({
      echoed: 1,
    });
  });

  it('reconnects with backoff when the connection drops or the unit is down', async () => {
    const h = await host('fake');
    const s = supervisor();
    await s.start();
    // The connector crashing closes the connection; the core reconnects and gets a new one.
    await s.call('fake', 'crash', {}, { signal: signal() });
    await until(() => (s.status()[0]?.restarts ?? 0) >= 1 && s.status()[0]?.state === 'up');
    await h.stop();
    hosts = [];
    await until(() => s.status()[0]?.state === 'down');
    await until(() =>
      (s.status()[0]?.error ?? '').includes('is 247-agent-connector@fake running?'),
    );
    await host('fake');
    await until(() => s.status()[0]?.state === 'up');
  });
});

describe('a unit without ops', () => {
  it('is external to the core', async () => {
    const s = supervisor();
    await s.start();
    expect(s.status().find((c) => c.name === 'plain')).toMatchObject({
      state: 'external',
      managed_by: 'systemd',
      pid: null,
      error: null,
    });
  });

  it('runs the process with the core socket, and stops it on stop()', async () => {
    const events = await coreSocket();
    const h = await host('plain');
    expect(h.socket).toBeUndefined();
    await until(() => events.length === 1);
    expect(JSON.parse(events[0] ?? '{}')).toMatchObject({ type: 'plain.started', source: 'plain' });
    await h.stop();
    await expect(h.done).resolves.toBe(0);
  });

  it('exits non-zero when the process dies, so systemd restarts the unit', async () => {
    // No core socket: fake-plain's first emit fails and the process exits.
    const h = await host('plain');
    await expect(h.done).resolves.toBe(1);
    expect(
      hostLogs
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.msg === 'connector_host.exited')
        .map(({ level, code }) => ({ level, code })),
    ).toEqual([{ level: 'warn', code: 1 }]);
  });
});
