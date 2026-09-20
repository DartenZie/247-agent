import { describe, expect, it } from 'vitest';

import { buildSandboxArgv, type PathProbe, Sandbox, SANDBOX_DEFAULT_CWD } from './sandbox.js';

/** A merged-/usr host: /bin and /lib are symlinks, /lib64 is absent. */
const probe: PathProbe = (path) => {
  switch (path) {
    case '/usr':
    case '/etc':
      return { kind: 'dir' };
    case '/bin':
      return { kind: 'symlink', target: 'usr/bin' };
    case '/lib':
      return { kind: 'symlink', target: 'usr/lib' };
    default:
      return undefined;
  }
};

const bwrap = Sandbox.parse('bwrap');

describe('Sandbox schema', () => {
  it('accepts the short and the long form and fills the lists', () => {
    expect(Sandbox.parse('none')).toEqual({
      backend: 'none',
      extra_args: [],
      ro_binds: [],
      rw_binds: [],
    });
    expect(Sandbox.parse({ backend: 'bwrap', ro_binds: ['/opt/x'] })).toEqual({
      backend: 'bwrap',
      extra_args: [],
      ro_binds: ['/opt/x'],
      rw_binds: [],
    });
    expect(Sandbox.safeParse('firejail').success).toBe(false);
    expect(Sandbox.safeParse({ backend: 'bwrap', user: 'nobody' }).success).toBe(false);
  });
});

describe('buildSandboxArgv', () => {
  it('isolates pid/ipc, mounts the OS read-only, binds only cwd read-write, clears env', () => {
    const argv = buildSandboxArgv({
      sandbox: bwrap,
      cmd: ['npm', 'run', 'build'],
      cwd: '/var/lib/247-agent/repos/site',
      env: { CI: '1' },
      hostEnv: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', OA_SECRET_X: 'leak', HOME: '/root' },
      probe,
    });
    expect(argv).toEqual([
      'bwrap',
      '--unshare-pid',
      '--unshare-ipc',
      '--die-with-parent',
      '--new-session',
      ...['--ro-bind', '/usr', '/usr'],
      ...['--symlink', 'usr/lib', '/lib'],
      ...['--symlink', 'usr/bin', '/bin'],
      ...['--ro-bind', '/etc', '/etc'],
      ...['--proc', '/proc'],
      ...['--dev', '/dev'],
      ...['--tmpfs', '/tmp'],
      ...['--bind', '/var/lib/247-agent/repos/site', '/var/lib/247-agent/repos/site'],
      ...['--chdir', '/var/lib/247-agent/repos/site'],
      '--clearenv',
      ...['--setenv', 'PATH', '/usr/bin:/bin'],
      ...['--setenv', 'HOME', '/var/lib/247-agent/repos/site'],
      ...['--setenv', 'LANG', 'C.UTF-8'],
      ...['--setenv', 'CI', '1'],
      '--',
      ...['npm', 'run', 'build'],
    ]);
    // Nothing from the host env but PATH/LANG, and no bind of /run, /var or /home.
    expect(argv).not.toContain('OA_SECRET_X');
    expect(argv).not.toContain('/root');
    expect(argv.filter((a) => a.startsWith('/run') || a === '/var' || a === '/home')).toEqual([]);
  });

  it('runs in the private /tmp when the action has no cwd and lets env override HOME/PATH', () => {
    const argv = buildSandboxArgv({
      sandbox: bwrap,
      cmd: ['sh', '-c', 'pwd'],
      cwd: undefined,
      env: { HOME: '/tmp/h', PATH: '/bin' },
      hostEnv: {},
      probe,
    });
    expect(argv).not.toContain('--bind');
    expect(argv.slice(argv.indexOf('--chdir'))).toEqual([
      ...['--chdir', SANDBOX_DEFAULT_CWD],
      '--clearenv',
      ...['--setenv', 'PATH', '/bin'],
      ...['--setenv', 'HOME', '/tmp/h'],
      '--',
      ...['sh', '-c', 'pwd'],
    ]);
  });

  it('adds ro_binds, rw_binds and extra_args after the built-in mounts, before --', () => {
    const argv = buildSandboxArgv({
      sandbox: Sandbox.parse({
        backend: 'bwrap',
        ro_binds: ['/opt/247-agent'],
        rw_binds: ['/srv/out'],
        extra_args: ['--unshare-net'],
      }),
      cmd: ['true'],
      cwd: '/w',
      env: {},
      hostEnv: {},
      probe: () => undefined,
    });
    expect(argv.slice(argv.indexOf('--bind'))).toEqual([
      ...['--bind', '/w', '/w'],
      ...['--ro-bind', '/opt/247-agent', '/opt/247-agent'],
      ...['--bind', '/srv/out', '/srv/out'],
      ...['--chdir', '/w'],
      '--clearenv',
      ...['--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin'],
      ...['--setenv', 'HOME', '/w'],
      '--unshare-net',
      '--',
      'true',
    ]);
  });
});
