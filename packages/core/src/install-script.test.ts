import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const target = `${process.platform}-${process.arch}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-install-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A release tarball with only what install.sh reads: VERSION and the two launchers. Its
 * entries are closed to other users, as a release built under umask 077 records them.
 */
function fakeRelease(version = '9.9.9'): string {
  const tree = join(root, 'src', `247-agent-${version}`);
  mkdirSync(join(tree, 'bin'), { recursive: true });
  writeFileSync(join(tree, 'VERSION'), `version=${version}\ntarget=${target}\nnode=22\n`);
  chmodSync(tree, 0o700);
  chmodSync(join(tree, 'bin'), 0o700);
  chmodSync(join(tree, 'VERSION'), 0o600);
  for (const name of ['247-agent-core', 'oa']) {
    writeFileSync(join(tree, 'bin', name), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(tree, 'bin', name), 0o700);
  }
  const tarball = join(root, `release-${version}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'src'), `247-agent-${version}`]);
  expect(tar.status).toBe(0);
  return tarball;
}

describe.skipIf(process.platform === 'win32')('install.sh', () => {
  it('installs a tree other users can run from a closed tarball under a restrictive umask', () => {
    const prefix = join(root, 'opt', '247-agent');
    const run = spawnSync(
      'sh',
      [
        '-c',
        'umask 077; exec sh "$@"',
        'sh',
        script,
        '--from',
        fakeRelease(),
        '--prefix',
        prefix,
        '--bin-dir',
        join(root, 'bin'),
        '--no-service',
      ],
      { encoding: 'utf8' },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const tree = `${prefix}-9.9.9`;
    for (const path of [tree, join(tree, 'bin'), join(tree, 'bin', '247-agent-core')]) {
      expect(statSync(path).mode & 0o777, path).toBe(0o755);
    }
    expect(statSync(join(tree, 'VERSION')).mode & 0o777).toBe(0o644);
  });

  it('re-owns the tree to root:root when root installs with --no-service into a writable prefix', () => {
    // A root caller can write every prefix, so the tree is not staged through sudo; the
    // owner the tarball recorded must still not survive (issue #86). Fake `id` and `chown`
    // let an unprivileged test see what root would run.
    const shims = join(root, 'shims');
    mkdirSync(shims);
    const log = join(root, 'chown.log');
    writeFileSync(join(shims, 'id'), '#!/bin/sh\necho 0\n');
    writeFileSync(join(shims, 'chown'), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    chmodSync(join(shims, 'id'), 0o755);
    chmodSync(join(shims, 'chown'), 0o755);
    const prefix = join(root, 'opt', '247-agent');
    const run = spawnSync(
      'sh',
      [
        script,
        '--from',
        fakeRelease(),
        '--prefix',
        prefix,
        '--bin-dir',
        join(root, 'bin'),
        '--no-service',
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` } },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe(`-R 0:0 ${prefix}-9.9.9.new\n`);
  });

  it('tells an upgrade without a restart to keep the old tree the daemon still runs from', () => {
    // Removing the old tree while the daemon still runs from it breaks the daemon, and the
    // rollback needs it too (issue #114).
    const prefix = join(root, 'opt', '247-agent');
    const install = (version: string) =>
      spawnSync(
        'sh',
        [
          script,
          '--from',
          fakeRelease(version),
          '--prefix',
          prefix,
          '--bin-dir',
          join(root, 'bin'),
          '--no-service',
        ],
        { encoding: 'utf8' },
      );
    expect(install('9.9.8').status).toBe(0);
    const run = install('9.9.9');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'remove an old version only after 247-agent runs on 9.9.9 and you no longer want to roll back to it',
    );
    expect(run.stdout).toContain(`  rm -rf ${prefix}-9.9.8\n`);
    expect(run.stdout).toContain(
      `247-agent was not restarted: if a daemon still runs 9.9.8, it uses ${prefix}-9.9.8; keep it until the restart`,
    );
  });

  it.each([
    ['INT', 130],
    ['TERM', 143],
  ])('stops after cleaning up on SIG%s, with status %i', (signal, code) => {
    // A `tar` shim unpacks the tarball, then signals the installer, as a Ctrl-C or a
    // SIGTERM during the unpack would. The installer must not carry on (issue #113).
    const shims = join(root, 'shims');
    mkdirSync(shims);
    const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
    const tmpLog = join(root, 'tmp.log');
    writeFileSync(
      join(shims, 'tar'),
      `#!/bin/sh\n"${realTar}" "$@" || exit\n` +
        `case "$*" in *-xzf*) echo "$4" > "${tmpLog}"; kill -${signal} "$PPID";; esac\n`,
    );
    chmodSync(join(shims, 'tar'), 0o755);
    const prefix = join(root, 'opt', '247-agent');
    const run = spawnSync(
      'sh',
      [
        script,
        '--from',
        fakeRelease(),
        '--prefix',
        prefix,
        '--bin-dir',
        join(root, 'bin'),
        '--no-service',
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` } },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(code);
    const tmp = dirname(readFileSync(tmpLog, 'utf8').trim());
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(`${prefix}-9.9.9`)).toBe(false);
  });
});
