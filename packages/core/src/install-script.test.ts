import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
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
function fakeRelease(version = '9.9.9', releaseTarget = target): string {
  const tree = join(root, 'src', `247-agent-${version}`);
  mkdirSync(join(tree, 'bin'), { recursive: true });
  writeFileSync(join(tree, 'VERSION'), `version=${version}\ntarget=${releaseTarget}\nnode=22\n`);
  // What the service part reads: the starter config, the units and the health check.
  mkdirSync(join(tree, 'share', 'etc', 'tasks.d'), { recursive: true });
  mkdirSync(join(tree, 'share', 'systemd'), { recursive: true });
  writeFileSync(join(tree, 'share', 'etc', 'agent.yaml'), 'tasks: [tasks.d]\n');
  writeFileSync(join(tree, 'share', 'etc', 'tasks.d', 'hello.yaml'), 'tasks: []\n');
  for (const unit of ['247-agent.service', '247-agent-connector@.service']) {
    writeFileSync(
      join(tree, 'share', 'systemd', unit),
      'ExecStart=/opt/247-agent/bin/247-agent-core\n',
    );
  }
  writeFileSync(join(tree, 'share', 'check-service.sh'), 'exit 0\n');
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

  it('prints the usage for --help when it is piped into sh', () => {
    // `curl … | sh -s -- --help` has no script file to read the usage from (issue #115).
    const run = spawnSync('sh', ['-s', '--', '--help'], {
      encoding: 'utf8',
      input: readFileSync(script),
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('curl -fsSL');
    expect(run.stdout).toContain('--prefix <dir>');
    expect(run.stdout).toContain('--no-restart');
  });

  it('refuses a musl host before it downloads or installs anything', () => {
    // The release bundles a glibc Node and SQLite addon; on Alpine they fail with
    // "not found" (issue #115). Shims make this host look like Alpine.
    const shims = join(root, 'shims');
    mkdirSync(shims);
    writeFileSync(
      join(shims, 'uname'),
      '#!/bin/sh\ncase $1 in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n',
    );
    writeFileSync(join(shims, 'ldd'), '#!/bin/sh\necho "musl libc (x86_64)" >&2\nexit 1\n');
    chmodSync(join(shims, 'uname'), 0o755);
    chmodSync(join(shims, 'ldd'), 0o755);
    const prefix = join(root, 'opt', '247-agent');
    const run = spawnSync(
      'sh',
      [script, '--from', join(root, 'none.tar.gz'), '--prefix', prefix, '--no-service'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` } },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('musl');
    expect(run.stderr).toContain('glibc');
    expect(run.stdout).toBe('');
    expect(existsSync(dirname(prefix))).toBe(false);
  });

  it('lets a glibc Linux host past the musl check, even with a musl loader installed', () => {
    // Debian's musl package puts /lib/ld-musl-*.so.1 next to glibc; that host is supported.
    const shims = join(root, 'shims');
    mkdirSync(shims);
    writeFileSync(
      join(shims, 'uname'),
      '#!/bin/sh\ncase $1 in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n',
    );
    writeFileSync(join(shims, 'ldd'), '#!/bin/sh\necho "ldd (Debian GLIBC 2.36-9) 2.36"\n');
    writeFileSync(join(shims, 'getconf'), '#!/bin/sh\necho "glibc 2.36"\n');
    for (const name of ['uname', 'ldd', 'getconf']) {
      chmodSync(join(shims, name), 0o755);
    }
    const missing = join(root, 'none.tar.gz');
    const run = spawnSync(
      'sh',
      [script, '--from', missing, '--prefix', join(root, 'opt', '247-agent'), '--no-service'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` } },
    );
    // It gets as far as reading the tarball.
    expect(run.stderr).toBe(`install.sh: no such file: ${missing}\n`);
  });

  it('refuses an installer symlink whose files a package later took over', () => {
    // install.sh first, then the .deb: dpkg records the files under the symlink, and moving
    // the symlink would take them away from it (issue #115).
    const prefix = join(root, 'opt', '247-agent');
    const install = (version: string, path: string) =>
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
        { encoding: 'utf8', env: { ...process.env, PATH: path } },
      );
    expect(install('9.9.8', process.env.PATH ?? '').status).toBe(0);
    const shims = join(root, 'shims');
    mkdirSync(shims);
    writeFileSync(
      join(shims, 'dpkg'),
      '#!/bin/sh\n[ "$1" = -S ] && echo "247-agent: $2" && exit 0\nexit 1\n',
    );
    chmodSync(join(shims, 'dpkg'), 0o755);
    const run = install('9.9.9', `${shims}:${process.env.PATH ?? ''}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${prefix} belongs to the installed package 247-agent;`);
    expect(readlinkSync(prefix)).toBe(`${prefix}-9.9.8`);
    expect(existsSync(`${prefix}-9.9.9`)).toBe(false);
  });

  it.each([
    ['dpkg', '#!/bin/sh\n[ "$1" = -S ] && echo "247-agent: $2" && exit 0\nexit 1\n', 'apt'],
    [
      'rpm',
      '#!/bin/sh\n[ "$1" = -qf ] || exit 1\n[ "$2" = --qf ] && echo 247-agent && exit 0\necho 247-agent-9.9.8-1.x86_64\n',
      'dnf',
    ],
  ])('refuses a prefix that belongs to a %s package and leaves it alone', (tool, shim, pm) => {
    // The .deb/.rpm and the installer both own /opt/247-agent; moving a package's tree
    // aside breaks the package (issue #115).
    const shims = join(root, 'shims');
    mkdirSync(shims);
    writeFileSync(join(shims, tool), shim);
    chmodSync(join(shims, tool), 0o755);
    const prefix = join(root, 'opt', '247-agent');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeFileSync(join(prefix, 'VERSION'), `version=9.9.8\ntarget=${target}\n`);
    writeFileSync(join(prefix, 'bin', '247-agent-core'), '#!/bin/sh\n');
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
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${prefix} belongs to the installed package 247-agent;`);
    expect(run.stderr).toContain(pm);
    expect(statSync(prefix).isDirectory()).toBe(true);
    expect(readFileSync(join(prefix, 'VERSION'), 'utf8')).toContain('version=9.9.8');
    expect(existsSync(`${prefix}-9.9.9`)).toBe(false);
    expect(existsSync(`${prefix}-9.9.9.new`)).toBe(false);
  });

  it('gives /etc/247-agent to root, readable by the service group (issue #117)', () => {
    // Owned by the service user, the daemon or a task could rewrite the config it trusts.
    // Shims make this host a glibc Linux with systemd where the caller is root, and log
    // what root would run against /etc instead of running it.
    const shims = join(root, 'shims');
    mkdirSync(shims);
    const log = join(root, 'root.log');
    const realFind = spawnSync('sh', ['-c', 'command -v find'], { encoding: 'utf8' }).stdout.trim();
    const shim = (name: string, body: string) => {
      writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(shims, name), 0o755);
    };
    shim('uname', 'case $1 in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac');
    shim('ldd', 'echo "ldd (Debian GLIBC 2.36-9) 2.36"');
    shim('getconf', 'echo "glibc 2.36"');
    shim('id', '[ "$1" = -u ] && echo 0; exit 0');
    for (const name of ['install', 'chown', 'systemctl', 'useradd']) {
      shim(name, `echo "${name} $*" >> "${log}"`);
    }
    shim(
      'find',
      `case $1 in /etc/*) echo "find $*" >> "${log}" ;; *) exec "${realFind}" "$@" ;; esac`,
    );
    const prefix = join(root, 'opt', '247-agent');
    const run = spawnSync(
      'sh',
      [
        script,
        '--from',
        fakeRelease('9.9.9', 'linux-x64'),
        '--prefix',
        prefix,
        '--bin-dir',
        join(root, 'bin'),
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` } },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const lines = readFileSync(log, 'utf8').split('\n');
    const tree = `${prefix}-9.9.9`;
    expect(lines).toContain(
      'install -d -m 750 -o root -g 247-agent /etc/247-agent /etc/247-agent/tasks.d /etc/247-agent/connectors.d',
    );
    expect(lines).toContain(
      `install -m 640 -o root -g 247-agent ${tree}/share/etc/agent.yaml /etc/247-agent/agent.yaml`,
    );
    expect(lines).toContain(
      `install -m 640 -o root -g 247-agent ${tree}/share/etc/tasks.d/hello.yaml /etc/247-agent/tasks.d/hello.yaml`,
    );
    // An install before #117 left the config with the service user; the upgrade takes it
    // back, but only what the group can still read once root owns it.
    expect(lines).toContain(
      'find /etc/247-agent -user 247-agent -group 247-agent ( -type f -perm -g=r -o -type d -perm -g=rx ) -exec chown -h root:247-agent {} ;',
    );
    expect(lines.filter((l) => l.includes('-o 247-agent'))).toEqual([]);
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
