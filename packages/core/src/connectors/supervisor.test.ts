import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentDefaults } from '../actions/agent-config.js';
import type { ConnectorConfig } from '../config/connector.js';
import { parseManifest } from '../config/connector.js';
import { createLogger } from '../log.js';
import { staticSecrets } from '../secrets/secrets.js';
import {
  ConnectorDownError,
  ConnectorOpError,
  ConnectorSupervisor,
  toolResultToJson,
} from './supervisor.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url).pathname;

function manifest(over: Record<string, unknown> = {}): ConnectorConfig {
  const r = parseManifest(
    {
      name: 'fake',
      exec: ['node', `${FIXTURES}fake-mcp.ts`],
      restart: { base: '20ms', max: '100ms' },
      ...over,
    },
    '/x/connectors.d/fake.yaml',
  );
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }
  return r.config;
}

let sup: ConnectorSupervisor | undefined;
let lines: Record<string, unknown>[];

function make(
  manifests: ConnectorConfig[],
  secrets: Record<string, string> = {},
): ConnectorSupervisor {
  lines = [];
  sup = new ConnectorSupervisor({
    manifests,
    socketPath: '/tmp/oa-test.sock',
    secrets: staticSecrets(secrets),
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
    env: { PATH: process.env.PATH ?? '', FAKE_EXTRA: 'from-base' },
  });
  return sup;
}

afterEach(async () => {
  await sup?.stop();
  sup = undefined;
});

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

describe('ConnectorSupervisor', () => {
  it('spawns an MCP connector with the documented env, calls ops and maps results', async () => {
    const s = make(
      [
        manifest({
          config: { token: '${secrets.tok}', n: 2 },
          env: { FAKE_EXTRA: '${secrets.tok}-x' },
        }),
      ],
      { tok: 'sekrit' },
    );
    await s.start();
    expect(s.status()).toMatchObject([{ name: 'fake', state: 'up', restarts: 0 }]);
    expect(s.names()).toEqual(['fake']);

    await expect(s.call('fake', 'env', {}, { signal: signal() })).resolves.toEqual({
      name: 'fake',
      socket: '/tmp/oa-test.sock',
      config: { token: 'sekrit', n: 2 },
      extra: 'sekrit-x',
    });
    await expect(
      s.call('fake', 'echo', { value: { a: [1, 'b'] } }, { signal: signal() }),
    ).resolves.toEqual({ echoed: { a: [1, 'b'] } });
    await expect(s.call('fake', 'text', {}, { signal: signal() })).resolves.toBe(
      'plain text, not JSON',
    );
    await expect(s.call('fake', 'fail', { message: 'nope' }, { signal: signal() })).rejects.toThrow(
      ConnectorOpError,
    );
    await expect(s.call('fake', 'fail', { message: 'nope' }, { signal: signal() })).rejects.toThrow(
      'fake.fail: nope',
    );
    await expect(s.call('nope', 'echo', {}, { signal: signal() })).rejects.toThrow(
      'unknown connector',
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'connector.output',
        connector: 'fake',
        line: 'fake-mcp fake starting',
      }),
    );
    // The secret value stays out of the log.
    expect(JSON.stringify(lines)).not.toContain('sekrit');
  });

  it('enforces the manifest op allowlist and times out slow ops', async () => {
    const s = make([manifest({ ops: ['echo', 'slow'] })]);
    await s.start();
    await expect(s.call('fake', 'env', {}, { signal: signal() })).rejects.toThrow(
      /not in the manifest/,
    );
    await expect(
      s.call('fake', 'slow', { ms: 2000 }, { signal: signal(), timeoutMs: 100 }),
    ).rejects.toThrow(/timed out|timeout/i);
    const controller = new AbortController();
    const p = s.call('fake', 'slow', { ms: 2000 }, { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow();
  });

  it('restarts a crashed connector with backoff and reports it down meanwhile', async () => {
    const s = make([manifest()]);
    await s.start();
    await expect(s.call('fake', 'crash', {}, { signal: signal() })).resolves.toEqual({
      crashing: true,
    });
    await until(() => s.status()[0]?.state === 'down');
    await expect(s.call('fake', 'echo', { value: 1 }, { signal: signal() })).rejects.toThrow(
      ConnectorDownError,
    );
    await until(() => s.status()[0]?.state === 'up');
    expect(s.status()[0]).toMatchObject({ state: 'up', restarts: 1 });
    await expect(s.call('fake', 'echo', { value: 1 }, { signal: signal() })).resolves.toEqual({
      echoed: 1,
    });
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['connector.exited', 'connector.restart_scheduled', 'connector.up']),
    );
  });

  it('keeps retrying a connector that cannot start, without a secret it needs', async () => {
    const s = make([manifest({ config: { t: '${secrets.missing}' } })]);
    await s.start();
    expect(s.status()[0]).toMatchObject({
      state: 'down',
      error: expect.stringMatching(/missing/) as string,
    });
    await until(() => (s.status()[0]?.restarts ?? 0) >= 2);
    const bad = make([manifest({ name: 'nope', exec: ['/nonexistent/binary'] })]);
    await bad.start();
    expect(bad.status()[0]).toMatchObject({ name: 'nope', state: 'down' });
    await bad.stop();
  });

  it('restart() respawns one connector with freshly resolved secrets and resets backoff', async () => {
    const secrets = { tok: 'v1' };
    const s = make([manifest({ config: { token: '${secrets.tok}' } })], secrets);
    await s.start();
    await expect(s.call('fake', 'env', {}, { signal: signal() })).resolves.toMatchObject({
      config: { token: 'v1' },
    });
    const before = s.status()[0]?.pid;
    await expect(s.call('fake', 'crash', {}, { signal: signal() })).resolves.toEqual({
      crashing: true,
    });
    await until(() => s.status()[0]?.state === 'up' && (s.status()[0]?.restarts ?? 0) > 0);

    secrets.tok = 'v2'; // rotated at the backend
    const status = await s.restart('fake');
    expect(status).toMatchObject({ name: 'fake', state: 'up', restarts: 0, error: null });
    expect(status.pid).not.toBe(before);
    await expect(s.call('fake', 'env', {}, { signal: signal() })).resolves.toMatchObject({
      config: { token: 'v2' },
    });
    await expect(s.restart('nope')).rejects.toThrow('unknown connector');
    expect(JSON.stringify(lines)).not.toMatch(/v1|v2/);
    expect(lines.map((l) => l.msg)).toContain('connector.restart_requested');
  });

  it('restart() of a plain process does not double-spawn it', async () => {
    // fake-plain.ts exits once its emit to the test socket fails; an idle process is needed here.
    const s = make([
      manifest({
        name: 'plain',
        transport: 'none',
        exec: ['node', '-e', 'setInterval(() => undefined, 60000)'],
      }),
    ]);
    await s.start();
    const first = s.status()[0]?.pid;
    const status = await s.restart('plain');
    expect(status).toMatchObject({ name: 'plain', state: 'up', restarts: 0 });
    expect(status.pid).not.toBe(first);
    await new Promise((r) => setTimeout(r, 200)); // long enough for a stray restart timer
    expect(lines.filter((l) => l.msg === 'connector.exited')).toEqual([]);
    expect(lines.filter((l) => l.msg === 'connector.up')).toHaveLength(2);
  });

  it('runs a transport: none connector as a plain process and refuses ops on it', async () => {
    const s = make([
      manifest({ name: 'plain', transport: 'none', exec: ['node', `${FIXTURES}fake-plain.ts`] }),
    ]);
    await s.start();
    expect(s.status()[0]).toMatchObject({ name: 'plain', state: 'up' });
    expect(s.status()[0]?.pid).toEqual(expect.any(Number));
    await expect(s.call('plain', 'x', {}, { signal: signal() })).rejects.toThrow(/serves no ops/);
    await until(() =>
      lines.some((l) => l.msg === 'connector.output' && l.line === 'fake-plain plain up'),
    );
    await s.stop();
    expect(s.status()[0]?.state).toBe('stopped');
  });
});

describe('ConnectorSupervisor with an acp connector', () => {
  const acp = (over: Record<string, unknown> = {}): ConnectorConfig =>
    manifest({
      name: 'claude',
      transport: 'acp',
      exec: ['node', `${FIXTURES}fake-acp.ts`],
      ...over,
    });

  it('spawns the agent, serves sessions, refuses ops and lists it as an agent', async () => {
    const s = make([acp(), manifest()]);
    await s.start();
    expect(s.status()).toMatchObject([
      { name: 'claude', transport: 'acp', state: 'up', restarts: 0 },
      { name: 'fake', transport: 'stdio', state: 'up' },
    ]);
    expect(s.agentNames()).toEqual(['claude']);
    expect(s.info('claude')).toEqual({ name: 'fake-acp', version: '0.1.0' });
    expect(s.info('fake')).toBeUndefined();
    await expect(s.call('claude', 'echo', {}, { signal: signal() })).rejects.toThrow(
      /serves no ops/,
    );
    await expect(
      s.open('fake', {
        cwd: '/tmp',
        signal: signal(),
        log: createLogger({ sink: () => undefined }),
        onPermission: () => 'cancelled',
      }),
    ).rejects.toThrow(/not an acp agent/);
    await expect(
      s.open('nope', {
        cwd: '/tmp',
        signal: signal(),
        log: createLogger({ sink: () => undefined }),
        onPermission: () => 'cancelled',
      }),
    ).rejects.toThrow(/unknown connector/);

    const session = await s.open('claude', {
      cwd: '/tmp',
      signal: signal(),
      log: createLogger({ sink: () => undefined }),
      onPermission: () => 'cancelled',
    });
    const gen = session.prompt('[[no-cost]]');
    let stop;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        stop = next.value;
        break;
      }
    }
    expect(stop).toMatchObject({ stopReason: 'end_turn' });
    session.close();
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'connector.acp_initialized',
        connector: 'claude',
        agent: 'fake-acp',
      }),
    );
  });

  it('restarts a crashed agent with backoff and reports it down meanwhile', async () => {
    const s = make([acp()]);
    await s.start();
    const session = await s.open('claude', {
      cwd: '/tmp',
      signal: signal(),
      log: createLogger({ sink: () => undefined }),
      onPermission: () => 'cancelled',
    });
    await expect(session.prompt('[[crash]]').next()).rejects.toThrow();
    await until(() => s.status()[0]?.state === 'down');
    await expect(
      s.open('claude', {
        cwd: '/tmp',
        signal: signal(),
        log: createLogger({ sink: () => undefined }),
        onPermission: () => 'cancelled',
      }),
    ).rejects.toThrow(ConnectorDownError);
    await until(() => s.status()[0]?.state === 'up');
    expect(s.status()[0]).toMatchObject({ state: 'up', restarts: 1 });
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['connector.exited', 'connector.restart_scheduled', 'connector.up']),
    );
  });

  it('keeps retrying a program that is not an ACP agent', async () => {
    const s = make([acp({ exec: ['node', '-e', 'process.exit(5)'] })]);
    await s.start();
    expect(s.status()[0]).toMatchObject({
      state: 'down',
      error: expect.stringMatching(/exited with code 5 before completing initialize/) as string,
    });
    await until(() => (s.status()[0]?.restarts ?? 0) >= 2);
  });
});

describe('toolResultToJson', () => {
  it('prefers structuredContent, parses JSON text, keeps plain text, joins several', () => {
    expect(toolResultToJson('c', 'o', { structuredContent: { a: 1 }, content: [] })).toEqual({
      a: 1,
    });
    expect(toolResultToJson('c', 'o', { content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({
      a: 1,
    });
    expect(toolResultToJson('c', 'o', { content: [{ type: 'text', text: 'hi' }] })).toBe('hi');
    expect(
      toolResultToJson('c', 'o', {
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toEqual(['a', 'b']);
    expect(toolResultToJson('c', 'o', { content: [] })).toBeNull();
    expect(() =>
      toolResultToJson('c', 'o', { isError: true, content: [{ type: 'text', text: 'bad' }] }),
    ).toThrow('c.o: bad');
  });
});

describe('ConnectorSupervisor health checks', () => {
  it('pings a stdio connector on its interval and respawns it after `failures` misses', async () => {
    const s = make([manifest({ health: { interval: '40ms', timeout: '60ms', failures: 2 } })]);
    await s.start();
    expect(s.status()[0]?.health).toEqual({ ok: null, checked_at: null, failures: 0 });
    await until(() => s.status()[0]?.health?.ok === true);
    expect(s.status()[0]?.health).toMatchObject({ ok: true, failures: 0 });
    const pid = s.status()[0]?.pid;

    // Block the connector's event loop: two pings in a row go unanswered.
    await expect(s.call('fake', 'freeze', { ms: 1500 }, { signal: signal() })).resolves.toEqual({
      freezing: 1500,
    });
    await until(() => s.status()[0]?.state === 'down', 3000);
    expect(s.status()[0]?.error).toMatch(/health checks failed 2 times/);
    await until(() => s.status()[0]?.state === 'up' && s.status()[0]?.pid !== pid, 5000);
    expect(s.status()[0]).toMatchObject({ restarts: 1, health: { ok: null, failures: 0 } });
    await expect(s.call('fake', 'echo', { value: 1 }, { signal: signal() })).resolves.toEqual({
      echoed: 1,
    });
    const msgs = lines.map((l) => l.msg);
    expect(msgs).toContain('connector.unhealthy');
    expect(msgs).toContain('connector.health_failed');
    expect(msgs.filter((m) => m === 'connector.health_ok').length).toBeGreaterThan(0);
  });

  it('reports no health for a manifest without it', async () => {
    const s = make([manifest()]);
    await s.start();
    expect(s.status()[0]?.health).toBeNull();
  });
});

describe('ConnectorSupervisor.apply', () => {
  it('adds, removes and respawns connectors to match a new manifest set', async () => {
    const secrets = { tok: 'v1' };
    const a = manifest({ name: 'a', config: { token: '${secrets.tok}' } });
    const b = manifest({ name: 'b' });
    const s = make([a, b], secrets);
    await s.start();
    const pidA = s.status().find((c) => c.name === 'a')?.pid;
    const pidB = s.status().find((c) => c.name === 'b')?.pid;

    // Same content, different file: unchanged. `b` goes, `c` arrives, `a` changes.
    const aMoved = { ...a, file: '/elsewhere/a.yaml' };
    expect(await s.apply([aMoved, manifest({ name: 'c' })])).toEqual({
      added: ['c'],
      removed: ['b'],
      changed: [],
    });
    expect(s.names().sort()).toEqual(['a', 'c']);
    expect(s.status().find((c) => c.name === 'a')?.pid).toBe(pidA);
    expect(s.status().find((c) => c.name === 'c')).toMatchObject({ state: 'up' });
    await expect(s.call('b', 'echo', {}, { signal: signal() })).rejects.toThrow(
      'unknown connector',
    );

    secrets.tok = 'v2';
    const aChanged = manifest({ name: 'a', config: { token: '${secrets.tok}', n: 2 } });
    expect(await s.apply([aChanged, manifest({ name: 'c' })])).toEqual({
      added: [],
      removed: [],
      changed: ['a'],
    });
    expect(s.status().find((c) => c.name === 'a')?.pid).not.toBe(pidA);
    await expect(s.call('a', 'env', {}, { signal: signal() })).resolves.toMatchObject({
      config: { token: 'v2', n: 2 },
    });
    expect(
      s
        .manifests()
        .map((m) => m.name)
        .sort(),
    ).toEqual(['a', 'c']);
    expect(pidB).toEqual(expect.any(Number));
    expect(lines.find((l) => l.msg === 'connector.set_applied')).toMatchObject({
      added: 'c',
      removed: 'b',
    });
    expect(JSON.stringify(lines)).not.toMatch(/v1|v2/);
  });
});

describe('ConnectorSupervisor with a sandboxed acp connector', () => {
  const BIN = `${FIXTURES}bin`;
  let dir: string;
  let logFile: string;
  let work: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oa-sbx-'));
    logFile = join(dir, 'bwrap.log');
    work = join(dir, 'work');
    mkdirSync(join(dir, 'cfg'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The fake bwrap on PATH records the argv the supervisor built, then runs the agent. */
  const makeSandboxed = (
    sandbox: unknown = { backend: 'bwrap', ro_binds: ['/srv/repos/site'] },
  ): ConnectorSupervisor => {
    lines = [];
    sup = new ConnectorSupervisor({
      manifests: [
        manifest({
          name: 'claude',
          transport: 'acp',
          exec: ['node', `${FIXTURES}fake-acp.ts`],
          env: { FAKE_MODEL_KEY: '${secrets.model_key}' },
          sandbox,
        }),
      ],
      socketPath: '/tmp/oa-test.sock',
      secrets: staticSecrets({ model_key: 'sk-not-real' }),
      log: createLogger({
        level: 'debug',
        sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
      }),
      env: {
        PATH: `${BIN}:${process.env.PATH ?? ''}`,
        FAKE_BWRAP_LOG: logFile,
        OA_HOME: '/opt/oa-test',
        FAKE_EXTRA: 'from-base',
        HOME: '/home/daemon',
      },
      agents: { defaults: AgentDefaults.parse({}), workDir: work },
      sandboxHost: { protected: [], masks: [join(dir, 'cfg'), '/nonexistent'], ro_binds: [] },
    });
    return sup;
  };
  const recorded = (): string[][] =>
    readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
  const pairs = (argv: string[], flag: string): string[][] =>
    argv.flatMap((a, i) => (a === flag ? [argv.slice(i + 1, i + 3)] : []));

  it('runs the agent program in bwrap with work_dir writable, its home inside and only its own env', async () => {
    const s = makeSandboxed();
    await s.start();
    expect(s.status()[0]).toMatchObject({ name: 'claude', state: 'up', sandbox: 'bwrap' });
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'connector.up', connector: 'claude', sandbox: 'bwrap' }),
    );
    const home = join(work, 'home', 'claude');
    expect(existsSync(home)).toBe(true);

    const [argv] = recorded();
    expect(argv).toBeDefined();
    const a = argv ?? [];
    expect(a.slice(0, 4)).toEqual([
      '--unshare-pid',
      '--unshare-ipc',
      '--die-with-parent',
      '--new-session',
    ]);
    expect(a).toContain('--proc');
    expect(pairs(a, '--bind')).toEqual([[work, work]]);
    expect(pairs(a, '--ro-bind')).toContainEqual(['/srv/repos/site', '/srv/repos/site']);
    expect(a).toContain('--tmpfs');
    expect(a[a.indexOf('--tmpfs', a.indexOf('--tmpfs') + 1) + 1]).toBe(join(dir, 'cfg'));
    expect(a).not.toContain('/nonexistent');
    expect(a.slice(a.indexOf('--chdir'), a.indexOf('--chdir') + 3)).toEqual([
      '--chdir',
      home,
      '--clearenv',
    ]);
    const env: Record<string, string> = Object.fromEntries(
      pairs(a, '--setenv').map(([k, v]) => [k ?? '', v ?? '']),
    );
    expect(env).toEqual({
      PATH: `${BIN}:${process.env.PATH ?? ''}`,
      HOME: home,
      OA_HOME: '/opt/oa-test',
      FAKE_MODEL_KEY: 'sk-not-real',
      OA_CONNECTOR_NAME: 'claude',
    });
    expect(a.slice(a.indexOf('--') + 1)).toEqual(['node', `${FIXTURES}fake-acp.ts`]);

    // The agent behind the wrapper serves sessions as usual.
    const session = await s.open('claude', {
      cwd: dir,
      signal: signal(),
      log: createLogger({ sink: () => undefined }),
      onPermission: () => 'cancelled',
    });
    const gen = session.prompt('[[no-cost]]');
    let stop;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        stop = next.value;
        break;
      }
    }
    expect(stop).toMatchObject({ stopReason: 'end_turn' });
    session.close();
  });

  it('respawns the sandboxed agent when work_dir moves on reload, and only then', async () => {
    const s = makeSandboxed();
    await s.start();
    expect(recorded()).toHaveLength(1);
    await s.configure({ defaults: AgentDefaults.parse({}), workDir: work });
    expect(recorded()).toHaveLength(1);

    const moved = join(dir, 'work2');
    await s.configure({ defaults: AgentDefaults.parse({}), workDir: moved });
    await until(() => s.status()[0]?.state === 'up');
    const argvs = recorded();
    expect(argvs).toHaveLength(2);
    expect(pairs(argvs[1] ?? [], '--bind')).toEqual([[moved, moved]]);
    expect(existsSync(join(moved, 'home', 'claude'))).toBe(true);
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'connector.restart_requested',
        connector: 'claude',
        reason: 'work_dir changed',
      }),
    );
    expect(s.workDir).toBe(moved);
  });

  it('reports an unsandboxed agent as such and keeps it out of bwrap', async () => {
    const s = makeSandboxed('none');
    await s.start();
    expect(s.status()[0]).toMatchObject({ state: 'up', sandbox: 'none' });
    expect(existsSync(logFile)).toBe(false);
  });
});
