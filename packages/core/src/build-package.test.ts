import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const script = fileURLToPath(new URL('../../../scripts/build-package.sh', import.meta.url));
const pkg = fileURLToPath(new URL('../../../package.json', import.meta.url));
const nfpm = fileURLToPath(new URL('../../../packaging/nfpm.yaml', import.meta.url));
const version = (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-pkg-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs `sha256sum -c` and `shasum -a 256 -c`, each one that is installed, on a checksum file in `dir`. */
function checkSha256(dir: string, file: string) {
  const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
  const runs = [
    has('sha256sum')
      ? spawnSync('sha256sum', ['-c', file], { cwd: dir, encoding: 'utf8' })
      : undefined,
    has('shasum')
      ? spawnSync('shasum', ['-a', '256', '-c', file], { cwd: dir, encoding: 'utf8' })
      : undefined,
  ].filter((r) => r !== undefined);
  expect(runs.length).toBeGreaterThan(0);
  return runs;
}

describe.skipIf(process.platform === 'win32')('build-package.sh', () => {
  it('writes .sha256 files that sha256sum -c and shasum -c accept (issue #116)', () => {
    const out = join(root, 'out');
    mkdirSync(join(out, `247-agent-${version}-linux-x64`), { recursive: true });
    writeFileSync(join(out, `247-agent-${version}-linux-x64`, 'VERSION'), `version=${version}\n`);

    // A fake nfpm: writes a package named after --packager into --target, like the real one.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'nfpm'),
      [
        '#!/bin/sh',
        'while [ $# -gt 0 ]; do case $1 in --packager) fmt=$2; shift 2 ;; --target) dir=$2; shift 2 ;; *) shift ;; esac; done',
        'f="${dir%/}/247-agent-test.$fmt"',
        'echo "$fmt package" > "$f"',
        'echo "created package: $f"',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'nfpm'), 0o755);

    const run = spawnSync('bash', [script, '--target', 'linux-x64', '--out', out], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    expect(run.status, run.stderr).toBe(0);

    for (const name of ['247-agent-test.deb', '247-agent-test.rpm']) {
      expect(readFileSync(join(out, `${name}.sha256`), 'utf8')).toMatch(
        new RegExp(`^[0-9a-f]{64} {2}${name.replace(/\./g, '\\.')}\\n$`),
      );
      for (const check of checkSha256(out, `${name}.sha256`)) {
        expect(check.status, check.stderr).toBe(0);
        expect(check.stdout).toBe(`${name}: OK\n`);
      }
    }
  });
});

describe('packaging/nfpm.yaml', () => {
  it('gives /etc/247-agent to root, readable by the service group (issue #117)', () => {
    // Owned by the service user, the daemon or a task could rewrite the config it trusts.
    const contents = (
      parse(readFileSync(nfpm, 'utf8')) as {
        contents: { dst: string; type?: string; file_info?: Record<string, unknown> }[];
      }
    ).contents;
    const etc = contents.filter((c) => c.dst.startsWith('/etc/247-agent'));
    expect(etc.map((c) => c.dst).sort()).toEqual([
      '/etc/247-agent',
      '/etc/247-agent/agent.yaml',
      '/etc/247-agent/connectors.d',
      '/etc/247-agent/tasks.d',
      '/etc/247-agent/tasks.d/hello.yaml',
    ]);
    for (const c of etc) {
      // The digits as written: nfpm reads 0640 as octal, the yaml package (YAML 1.2) as 640.
      expect(c.file_info, c.dst).toEqual({
        mode: c.type === 'dir' ? 750 : 640,
        owner: 'root',
        group: '247-agent',
      });
    }
  });
});
