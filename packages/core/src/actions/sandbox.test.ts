import { describe, expect, it } from 'vitest';

import { NET_BRIDGE_SOURCE, SANDBOX_NET_SOCKET } from './sandbox-net.js';
import {
  AgentSandbox,
  buildSandboxArgv,
  canonicalPath,
  type PathProbe,
  Sandbox,
  SANDBOX_DEFAULT_CWD,
  sandboxHost,
} from './sandbox.js';

/** A merged-/usr host: /bin and /lib are symlinks, /lib64 is absent; the daemon's dirs exist. */
const probe: PathProbe = (path) => {
  switch (path) {
    case '/usr':
    case '/etc':
    case '/etc/247-agent':
    case '/var/lib/247-agent':
    case '/opt/247-agent':
    case '/srv/oa/checkout':
    case '/home/dev/.nvm/versions/node/v22.0.0':
      return { kind: 'dir' };
    case '/etc/agent.yaml':
    case '/etc/247-agent/agent.yaml':
    case '/srv/oa/checkout/state.db':
      return { kind: 'file' };
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

  it('takes a network allowlist on an agent sandbox only, and only with bwrap', () => {
    expect(
      AgentSandbox.parse({ backend: 'bwrap', network: { allow: ['api.anthropic.com'] } }),
    ).toEqual({
      backend: 'bwrap',
      extra_args: [],
      ro_binds: [],
      rw_binds: [],
      network: { allow: ['api.anthropic.com'] },
    });
    expect(AgentSandbox.parse('bwrap')).toEqual(Sandbox.parse('bwrap'));
    const off = AgentSandbox.safeParse({ backend: 'none', network: { allow: [] } });
    expect(off.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['network', expect.stringContaining('needs backend: bwrap')],
    ]);
    expect(
      AgentSandbox.safeParse({ backend: 'bwrap', network: { allow: ['http://x'] } }).success,
    ).toBe(false);
    const shared = AgentSandbox.safeParse({
      backend: 'bwrap',
      extra_args: ['--share-net'],
      network: { allow: [] },
    });
    expect(shared.error?.issues.map((i) => i.path.join('.'))).toEqual(['extra_args']);
    // A shell action's sandbox has no proxy to go with it.
    expect(Sandbox.safeParse({ backend: 'bwrap', network: { allow: [] } }).success).toBe(false);
  });
});

describe('buildSandboxArgv', () => {
  it('isolates pid/ipc, mounts the OS read-only, binds only cwd read-write, clears env', () => {
    const argv = buildSandboxArgv({
      sandbox: bwrap,
      cmd: ['npm', 'run', 'build'],
      writable: '/var/lib/247-agent/repos/site',
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

  it('shares the network unless told otherwise, and can cut it off', () => {
    const base = { sandbox: bwrap, cmd: ['agent'], writable: '/work', env: {}, hostEnv: {}, probe };
    expect(buildSandboxArgv(base)).not.toContain('--unshare-net');
    const offline = buildSandboxArgv({ ...base, net: {} });
    expect(offline.slice(0, 6)).toEqual([
      'bwrap',
      '--unshare-pid',
      '--unshare-ipc',
      '--die-with-parent',
      '--new-session',
      '--unshare-net',
    ]);
    expect(offline.slice(offline.indexOf('--'))).toEqual(['--', 'agent']);
    expect(offline).not.toContain(SANDBOX_NET_SOCKET);
  });

  it('binds the proxy socket last and runs the command behind the bridge', () => {
    const argv = buildSandboxArgv({
      sandbox: { ...bwrap, ro_binds: ['/srv/repos/site'], extra_args: ['--hostname', 'box'] },
      cmd: ['npx', '-y', 'agent'],
      writable: '/work',
      env: { KEY: 'v' },
      hostEnv: {},
      net: { proxySocket: '/run/247-agent/core.sock.net/1.sock', execPath: '/opt/node/bin/node' },
      probe,
    });
    expect(argv).toContain('--unshare-net');
    // After every other mount, so nothing shadows it; the socket only, read-only.
    expect(argv.slice(argv.indexOf('/srv/repos/site') + 2, argv.indexOf('--chdir'))).toEqual([
      '--ro-bind',
      '/run/247-agent/core.sock.net/1.sock',
      SANDBOX_NET_SOCKET,
    ]);
    expect(argv.slice(argv.indexOf('--hostname'))).toEqual([
      ...['--hostname', 'box'],
      '--',
      ...['/opt/node/bin/node', '-e', NET_BRIDGE_SOURCE, '--', SANDBOX_NET_SOCKET],
      ...['npx', '-y', 'agent'],
    ]);
    // The proxy variables are the bridge's to set: it alone knows its port.
    expect(argv.join(' ')).not.toMatch(/--setenv HTTPS?_PROXY/);
  });

  it('runs in the private /tmp when the action has no cwd and lets env override HOME/PATH', () => {
    const argv = buildSandboxArgv({
      sandbox: bwrap,
      cmd: ['sh', '-c', 'pwd'],
      writable: undefined,
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
      writable: '/w',
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

  it('mounts the install after the OS, masks the daemon dirs after that, then the writable path', () => {
    const argv = buildSandboxArgv({
      sandbox: Sandbox.parse({
        backend: 'bwrap',
        ro_binds: ['/var/lib/247-agent/repos/site'],
      }),
      cmd: ['npx', 'agent'],
      writable: '/var/lib/247-agent/work',
      cwd: '/var/lib/247-agent/work/home/claude',
      home: '/var/lib/247-agent/work/home/claude',
      env: { ANTHROPIC_API_KEY: 'k' },
      host: {
        protected: [],
        masks: ['/etc/247-agent', '/var/lib/247-agent', '/run/247-agent', '/nonexistent'],
        ro_binds: ['/opt/247-agent', '/missing/node'],
      },
      hostEnv: { PATH: '/opt/247-agent/bin:/usr/bin', HOME: '/var/lib/247-agent' },
      probe,
    });
    const from = argv.indexOf('--tmpfs');
    expect(argv.slice(from)).toEqual([
      ...['--tmpfs', '/tmp'],
      ...['--ro-bind', '/opt/247-agent', '/opt/247-agent'],
      ...['--tmpfs', '/etc/247-agent'],
      ...['--tmpfs', '/var/lib/247-agent'],
      ...['--bind', '/var/lib/247-agent/work', '/var/lib/247-agent/work'],
      ...['--ro-bind', '/var/lib/247-agent/repos/site', '/var/lib/247-agent/repos/site'],
      ...['--chdir', '/var/lib/247-agent/work/home/claude'],
      '--clearenv',
      ...['--setenv', 'PATH', '/opt/247-agent/bin:/usr/bin'],
      ...['--setenv', 'HOME', '/var/lib/247-agent/work/home/claude'],
      ...['--setenv', 'ANTHROPIC_API_KEY', 'k'],
      '--',
      ...['npx', 'agent'],
    ]);
    // Masks and install binds that do not exist on the host are left out (bwrap would fail on them).
    expect(argv).not.toContain('/run/247-agent');
    expect(argv).not.toContain('/nonexistent');
    expect(argv).not.toContain('/missing/node');
  });
});

describe('buildSandboxArgv with protected files a mount would show', () => {
  it('binds /dev/null over them unless a mask already hides them', () => {
    const argv = buildSandboxArgv({
      sandbox: Sandbox.parse('bwrap'),
      cmd: ['true'],
      writable: undefined,
      env: {},
      host: {
        protected: [
          { path: '/etc/agent.yaml', what: 'config file' },
          { path: '/etc/247-agent/agent.yaml', what: 'config file' },
          { path: '/srv/oa/checkout/state.db', what: 'database' },
          { path: '/srv/oa/state.db', what: 'database' },
          { path: '/run/oa/core.sock', what: 'socket' },
        ],
        masks: ['/etc/247-agent'],
        ro_binds: ['/srv/oa/checkout'],
      },
      hostEnv: {},
      probe,
    });
    const hidden = argv.flatMap((a, i) =>
      a === '--ro-bind' && argv[i + 1] === '/dev/null' ? [argv[i + 2]] : [],
    );
    // Under `/etc` and under the install: hidden. Under a mask, under nothing, or absent: not needed.
    expect(hidden).toEqual(['/etc/agent.yaml', '/srv/oa/checkout/state.db']);
    // The mask comes before the /dev/null binds, both before the command's own mounts.
    expect(argv.indexOf('/etc/247-agent')).toBeLessThan(argv.indexOf('/dev/null'));
  });
});

describe('sandboxHost', () => {
  it('masks the directories of the protected files and binds the install root and Node prefix', () => {
    const host = sandboxHost({
      protected: [
        { path: '/var/lib/247-agent/state.db', what: 'database' },
        { path: '/run/247-agent/core.sock', what: 'socket' },
        { path: '/run/247-agent/core.sock.net', what: 'proxy socket directory', dir: true },
        { path: '/etc/247-agent/agent.yaml', what: 'config file' },
        { path: '/etc/247-agent/secrets.yaml', what: 'secrets file' },
      ],
      env: { OA_HOME: '/opt/247-agent' },
      execPath: '/opt/247-agent/node/bin/node',
    });
    // The proxy sockets' directory lies in the socket's, which is masked: no mask of its own.
    expect(host.masks).toEqual(
      ['/var/lib/247-agent', '/run/247-agent', '/etc/247-agent'].map(canonicalPath),
    );
    // The vendored Node lives inside the install root: one bind.
    expect(host.ro_binds).toEqual(['/opt/247-agent'].map(canonicalPath));
    expect(host.protected.map((p) => p.what)).toEqual([
      'database',
      'socket',
      'proxy socket directory',
      'config file',
      'secrets file',
    ]);
  });

  it('binds a Node outside the install and skips what the OS mounts cover or would break', () => {
    const host = sandboxHost({
      protected: [
        { path: '/state.db', what: 'database' },
        { path: '/etc/agent.yaml', what: 'config file' },
        { path: '/srv/oa/data/state.db', what: 'database' },
        { path: '/srv/oa/state.db', what: 'database' },
        { path: '/srv/oa/checkout/core.sock', what: 'socket' },
        { path: '/srv/oa/checkout/core.sock.net', what: 'proxy socket directory', dir: true },
      ],
      env: { OA_HOME: '/srv/oa/checkout' },
      execPath: '/home/dev/.nvm/versions/node/v22.0.0/bin/node',
    });
    // `/` and `/etc` are never masked, nor `/srv/oa`, which holds the install; `/srv/oa/data` is.
    // Nor the install for the socket in it, so the proxy sockets' directory there is, itself.
    expect(host.masks).toEqual(
      ['/srv/oa/data', '/srv/oa/checkout/core.sock.net'].map(canonicalPath),
    );
    expect(host.ro_binds).toEqual(
      ['/srv/oa/checkout', '/home/dev/.nvm/versions/node/v22.0.0'].map(canonicalPath),
    );
    expect(sandboxHost({ protected: [], env: {}, execPath: '/usr/bin/node' }).ro_binds).toEqual([]);
  });
});
