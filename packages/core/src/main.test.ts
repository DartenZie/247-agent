import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
