import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const MAIN = new URL('../dist/main.js', import.meta.url).pathname;

const until = async (pred: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('247-agent-core', () => {
  it('survives a SIGHUP during startup and reloads once it is up (#103)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-'));
    const d = dir;
    // A sandboxed task makes startup probe bwrap; this bwrap holds the probe open until
    // the test lets it go, so the SIGHUP lands while startDaemon is still pending.
    const probing = join(d, 'probing');
    const release = join(d, 'release');
    // OA_HOME/bin comes first on the daemon's PATH (home.ts), ahead of a real bwrap.
    mkdirSync(join(d, 'bin'));
    const fake = join(d, 'bin', 'bwrap');
    writeFileSync(
      fake,
      `#!/bin/sh\ntouch '${probing}'\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    writeFileSync(join(d, 'agent.yaml'), 'db: s.db\nsocket: s\ntasks: tasks.yaml\n');
    writeFileSync(
      join(d, 'tasks.yaml'),
      [
        'tasks:',
        '  - name: boxed',
        '    trigger: { kind: manual }',
        '    action: { kind: shell, cmd: ["true"], sandbox: { backend: bwrap } }',
        '',
      ].join('\n'),
    );
    const out: string[] = [];
    const child = spawn(process.execPath, [MAIN, '--config', join(d, 'agent.yaml')], {
      env: { ...process.env, OA_HOME: d, NOTIFY_SOCKET: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b: Buffer) => out.push(b.toString()));
    child.stderr.on('data', (b: Buffer) => out.push(b.toString()));
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('exit', (code, signal) => {
      exited = { code, signal };
    });
    try {
      await until(() => existsSync(probing) || exited !== undefined, 'the bwrap probe');
      expect(exited, out.join('')).toBeUndefined();
      child.kill('SIGHUP');
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(release, '');
      await until(
        () => out.join('').includes('daemon.reloaded') || exited !== undefined,
        'the deferred reload',
      );
      expect(exited, out.join('')).toBeUndefined();
      expect(existsSync(join(d, 's'))).toBe(true);
    } finally {
      if (exited === undefined) {
        child.kill('SIGTERM');
        await until(() => exited !== undefined, 'the daemon to stop').catch(() => {
          child.kill('SIGKILL');
        });
      }
    }
  }, 30_000);

  it('logs signals at the level a reload set (#107)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-'));
    const d = dir;
    const agentYaml = join(d, 'agent.yaml');
    // A systemd-notify that always fails: STOPPING=1 at the SIGTERM logs systemd.notify_failed.
    mkdirSync(join(d, 'bin'));
    writeFileSync(join(d, 'bin', 'systemd-notify'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(d, 'bin', 'systemd-notify'), 0o755);
    writeFileSync(agentYaml, 'db: s.db\nsocket: s\ntasks: tasks.yaml\nlog: { level: info }\n');
    writeFileSync(
      join(d, 'tasks.yaml'),
      'tasks:\n  - { name: hello, trigger: { kind: manual }, action: { kind: shell, cmd: ["true"] } }\n',
    );
    const out: string[] = [];
    const child = spawn(process.execPath, [MAIN, '--config', agentYaml], {
      env: { ...process.env, OA_HOME: d, NOTIFY_SOCKET: join(d, 'notify') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b: Buffer) => out.push(b.toString()));
    child.stderr.on('data', (b: Buffer) => out.push(b.toString()));
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('exit', (code, signal) => {
      exited = { code, signal };
    });
    try {
      await until(
        () => out.join('').includes('READY=1') || exited !== undefined,
        'the daemon to start',
      );
      expect(exited, out.join('')).toBeUndefined();
      writeFileSync(agentYaml, 'db: s.db\nsocket: s\ntasks: tasks.yaml\nlog: { level: error }\n');
      // `oa reload`: returns once the new level is applied.
      const report = await new Promise<string>((resolve, reject) => {
        const req = request(
          { socketPath: join(d, 's'), method: 'POST', path: '/v1/reload' },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => {
              resolve(body);
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(JSON.parse(report)).toMatchObject({ ok: true });
      child.kill('SIGHUP');
      child.kill('SIGTERM');
      await until(() => exited !== undefined, 'the daemon to stop');
      const log = out.join('');
      expect(exited, log).toEqual({ code: 0, signal: null });
      expect(log).not.toContain('daemon.signal');
      expect(log).not.toContain('STOPPING=1');
    } finally {
      if (exited === undefined) {
        child.kill('SIGKILL');
      }
    }
  }, 30_000);
});
