import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectorConfig } from '../../config/connector.js';
import { parseManifest } from '../../config/connector.js';
import { createLogger } from '../../log.js';
import { Metrics } from '../../metrics.js';
import { OutputLimiter } from '../output.js';
import { AcpLauncher } from './acp.js';
import { launcherKind, type Launched, type LaunchRequest } from './index.js';
import { NetProxyPool } from './net-proxy-pool.js';
import { processLauncher } from './process.js';
import { socketLauncher } from './socket.js';
import { stdioLauncher } from './stdio.js';

const FIXTURES = new URL('../../../test/fixtures/', import.meta.url).pathname;

function manifest(over: Record<string, unknown> = {}): ConnectorConfig {
  const r = parseManifest(
    { name: 'fake', exec: ['node', `${FIXTURES}fake-mcp.ts`], ...over },
    '/x/connectors.d/fake.yaml',
  );
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }
  return r.config;
}

const launched: Launched[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(launched.splice(0).map((l) => l.stop()));
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function request(m: ConnectorConfig, over: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    manifest: m,
    env: () => ({
      PATH: process.env.PATH ?? '',
      OA_CORE_SOCKET: '/nonexistent/core.sock',
      OA_CONNECTOR_NAME: m.name,
    }),
    log: createLogger({ sink: () => undefined }),
    outputLimiter: () => new OutputLimiter(),
    signal: new AbortController().signal,
    wanted: () => true,
    ...over,
  };
}

async function keep(p: Promise<Launched | undefined>): Promise<Launched> {
  const l = await p;
  if (l === undefined) {
    throw new Error('not launched');
  }
  launched.push(l);
  return l;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('launcherKind', () => {
  it('picks a launcher by transport and manager', () => {
    expect(launcherKind(manifest())).toBe('stdio');
    expect(launcherKind(manifest({ transport: 'none' }))).toBe('process');
    expect(launcherKind(manifest({ transport: 'acp' }))).toBe('acp');
    expect(launcherKind(manifest({ managed_by: 'systemd' }))).toBe('socket');
    expect(launcherKind(manifest({ managed_by: 'systemd', transport: 'none' }))).toBe('external');
  });
});

describe('processLauncher', () => {
  it('ends with the exit code of a program that exits on its own', async () => {
    const l = await keep(
      processLauncher.launch(
        request(manifest({ transport: 'none', exec: ['node', '-e', 'process.exit(3)'] })),
      ),
    );
    expect(typeof l.pid).toBe('number');
    expect(l.client).toBeUndefined();
    await expect(l.ended).resolves.toBe('exit code 3');
  });

  it('stops the program and resolves once it has exited', async () => {
    const l = await keep(
      processLauncher.launch(
        request(
          manifest({ transport: 'none', exec: ['node', '-e', 'setInterval(() => 0, 1000)'] }),
        ),
      ),
    );
    const pid = l.pid ?? -1;
    expect(alive(pid)).toBe(true);
    await l.stop();
    expect(alive(pid)).toBe(false);
  });

  it('refuses an empty exec and an environment that cannot be prepared', async () => {
    await expect(
      processLauncher.launch(request({ ...manifest({ transport: 'none' }), exec: [] })),
    ).rejects.toThrow('exec is empty (a built-in connector is not spawned)');
    await expect(
      processLauncher.launch(
        request(manifest({ transport: 'none' }), {
          env: () => {
            throw new Error('no secret "tok"');
          },
        }),
      ),
    ).rejects.toThrow('cannot prepare environment: no secret "tok"');
  });
});

describe('stdioLauncher', () => {
  it('connects an MCP client to the child and ends when the child exits', async () => {
    const l = await keep(stdioLauncher.launch(request(manifest())));
    expect(typeof l.pid).toBe('number');
    const tools = await l.client?.listTools();
    expect(tools?.tools.map((t) => t.name)).toContain('echo');
    process.kill(l.pid ?? -1, 'SIGKILL');
    await expect(l.ended).resolves.toBe('process exited');
  });

  it('fails a program that does not speak MCP', async () => {
    await expect(
      stdioLauncher.launch(request(manifest({ exec: ['node', '-e', 'process.exit(1)'] }))),
    ).rejects.toThrow(/^cannot start: /);
  });
});

describe('socketLauncher', () => {
  it("names the unit when it cannot reach the unit's socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-'));
    dirs.push(dir);
    const socket = join(dir, 's');
    await expect(
      socketLauncher.launch(request(manifest({ managed_by: 'systemd', socket }))),
    ).rejects.toThrow(`cannot connect to ${socket} (is 247-agent-connector@fake running?)`);
  });
});

describe('AcpLauncher', () => {
  it('spawns the agent and ends when its process exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-launch-'));
    dirs.push(dir);
    const pool = new NetProxyPool({ dir: join(dir, 'net'), metrics: new Metrics() });
    const acp = new AcpLauncher({
      workDir: () => join(dir, 'work'),
      sandboxHost: undefined,
      hostEnv: { PATH: process.env.PATH ?? '' },
      proxies: pool,
    });
    const l = await keep(
      acp.launch(
        request(
          manifest({ name: 'claude', transport: 'acp', exec: ['node', `${FIXTURES}fake-acp.ts`] }),
        ),
      ),
    );
    expect(l.acp?.info).toEqual({ name: 'fake-acp', version: '0.1.0' });
    process.kill(l.pid ?? -1, 'SIGKILL');
    await expect(l.ended).resolves.toBe('process exited');
    await pool.closeAll();
  });
});
