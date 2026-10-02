import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { z } from 'zod';

import {
  NET_BRIDGE_SOURCE,
  SANDBOX_NET_SOCKET,
  SandboxNetwork,
  type SandboxNet,
} from './sandbox-net.js';

/**
 * Sandbox for `shell` actions (ARCHITECTURE §5.1) and for the agent program behind a
 * `transport: acp` connector (§5.4, §6, §11). `none` runs the command as the daemon
 * itself. `bwrap` wraps it in bubblewrap: its own pid and ipc namespaces, a read-only view
 * of the OS (`/usr`, `/lib`, `/lib64`, `/bin`, `/etc`) and of the install (`SandboxHost`),
 * a private `/tmp`, one writable directory (the action's `cwd`, the agents' `work_dir`),
 * and an environment that holds nothing but the given `env` plus `PATH`, `HOME` and
 * `LANG`. The daemon's runtime directory (the core socket), its config and state
 * directories and `/proc` of other processes are not visible.
 */
const Backend = z.enum(['none', 'bwrap']);

const SandboxObject = z.strictObject({
  backend: Backend,
  /** Extra bwrap arguments, placed after the built-in ones and before `--`. */
  extra_args: z.array(z.string()).default([]),
  /** Host paths mounted read-only at the same path (a repo, `/opt/247-agent`, …). */
  ro_binds: z.array(z.string().min(1)).default([]),
  /** Host paths mounted read-write at the same path. */
  rw_binds: z.array(z.string().min(1)).default([]),
});

/** The short form, `sandbox: bwrap`: that backend with nothing added. */
const BackendOnly = Backend.transform((backend) => ({
  backend,
  extra_args: [],
  ro_binds: [],
  rw_binds: [],
}));

/** `sandbox: bwrap` or `sandbox: { backend: bwrap, ro_binds: [...], ... }`. */
export const Sandbox = z.union([BackendOnly, SandboxObject]);

export type SandboxConfig = z.infer<typeof SandboxObject>;
export type SandboxBackend = z.infer<typeof Backend>;

const AgentSandboxObject = SandboxObject.extend({
  /**
   * What the agent program may reach: `{ allow: [host[:port], …] }`, enforced by the
   * daemon's proxy (`sandbox-net.ts`); `allow: []` is no network. Absent: the host's.
   */
  network: SandboxNetwork.optional(),
}).superRefine((s, ctx) => {
  if (s.network !== undefined && s.backend === 'none') {
    ctx.addIssue({
      code: 'custom',
      path: ['network'],
      message: 'a network allowlist needs backend: bwrap (nothing confines the program without it)',
    });
  }
  if (s.network !== undefined && s.extra_args.includes('--share-net')) {
    ctx.addIssue({
      code: 'custom',
      path: ['extra_args'],
      message: '--share-net would give the sandbox the host network back: drop it or drop network',
    });
  }
});

/**
 * `sandbox` of an `acp` manifest: the forms of `Sandbox` plus `network`, which only the
 * agent program has (its proxy lives as long as the process; a `shell` action cuts the
 * network with `extra_args: [--unshare-net]`).
 */
export const AgentSandbox = z.union([BackendOnly, AgentSandboxObject]);

export type AgentSandboxConfig = z.infer<typeof AgentSandboxObject>;

/** Host directories the sandbox sees read-only, when they exist. */
export const BASE_RO_PATHS = ['/usr', '/lib', '/lib64', '/bin', '/etc'] as const;

/** Working directory inside the sandbox when the action declares no `cwd`. */
export const SANDBOX_DEFAULT_CWD = '/tmp';

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

/** True when `target` is `dir` itself or inside it (both resolved, neither followed). */
export function isInsidePath(dir: string, target: string): boolean {
  const base = resolve(dir);
  const t = resolve(target);
  return t === base || t.startsWith(base + sep);
}

/**
 * The path with every symlink resolved, like `realpath -m`: the longest existing prefix
 * is resolved and the rest appended as spelled, so a file that does not exist yet (the
 * socket, a first start's database) still lands next to its real neighbours. Every
 * comparison of a bind against a protected path goes through this on both sides.
 */
export function canonicalPath(path: string): string {
  let dir = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(dir), ...rest);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        return join(dir, ...rest);
      }
      rest.unshift(basename(dir));
      dir = parent;
    }
  }
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

let bases: string[] | undefined;

/** The base read-only paths as spelled and as they really are (`/etc` may be a symlink). */
function basePaths(): string[] {
  bases ??= unique([...BASE_RO_PATHS, ...BASE_RO_PATHS.map(canonicalPath)]);
  return bases;
}

/** Inside one of the base read-only paths, so already visible; or one of them. */
function underBase(path: string): boolean {
  return basePaths().some((b) => isInsidePath(b, path));
}

/** A directory that can be replaced by an empty tmpfs without taking the OS with it. */
function maskable(path: string): boolean {
  return path !== '/' && !basePaths().some((b) => isInsidePath(path, b));
}

/**
 * What every sandbox on this host hides and shows, fixed for the daemon's lifetime
 * (ARCHITECTURE §11). `masks` are directories replaced by an empty tmpfs so the daemon's
 * own files never show through the read-only `/etc` or a wide bind: the directories of
 * the config file (tasks, manifests, prompts, a `file` secrets backend), the database and
 * the socket, plus a protected directory itself where none of those covers it (the proxy
 * sockets' directory when the core socket lies in the install root). `ro_binds` are what
 * a child needs to run at all: the install root (`OA_HOME`: `bin/` and the bundled
 * connectors) and the prefix of the daemon's Node (`node`, `npm`, `npx`), since both are
 * first on the `PATH` every child gets. Both lists hold canonical paths; a mask is skipped
 * when it is `/`, would cover an OS directory or the install itself. A protected file left
 * uncovered that way but shown by an OS or install mount (`/etc/agent.yaml`, a database
 * beside a checkout) is bound to `/dev/null` by `buildSandboxArgv` instead.
 */
export interface SandboxHost {
  /**
   * What must stay out of every sandbox: the db, the socket, `agent.yaml`, the secrets
   * file, the directory of the network allowlist proxies' sockets.
   */
  readonly protected: readonly ProtectedPath[];
  readonly masks: readonly string[];
  readonly ro_binds: readonly string[];
}

/** One path the daemon keeps out of every sandbox, with what to call it in a message. */
export interface ProtectedPath {
  path: string;
  /** `database`, `socket`, `config file`, `secrets file`, `proxy socket directory`. */
  what: string;
  /**
   * A directory that is the daemon's alone, not a file: masked itself rather than only
   * through its parent, and no bind may lie inside it either.
   */
  dir?: boolean | undefined;
}

export interface SandboxHostOptions {
  /** The database, the socket, `agent.yaml` and, with the `file` backend, the secrets file. */
  protected: readonly ProtectedPath[];
  /** Where `OA_HOME` comes from; defaults to the daemon's environment. */
  env?: NodeJS.ProcessEnv | undefined;
  /** The daemon's Node binary; defaults to `process.execPath`. */
  execPath?: string | undefined;
}

export function sandboxHost(opts: SandboxHostOptions): SandboxHost {
  const env = opts.env ?? process.env;
  const protectedPaths = opts.protected.map((p) => ({ ...p, path: canonicalPath(p.path) }));
  const home = env.OA_HOME;
  const nodePrefix = dirname(dirname(canonicalPath(opts.execPath ?? process.execPath)));
  const wanted = unique([
    ...(home === undefined || home === '' ? [] : [canonicalPath(home)]),
    nodePrefix,
  ]).filter((p) => p !== '/' && !underBase(p));
  // The Node prefix of a release tree lives inside the install root: one bind is enough.
  const ro_binds = wanted.filter((p, i) => !wanted.some((q, j) => j !== i && isInsidePath(q, p)));
  // A mask over the install would hide `bin/` and Node from every child: hide the file instead.
  const masks = unique(protectedPaths.map((p) => (p.dir === true ? p.path : dirname(p.path))))
    .filter((d) => maskable(d) && !ro_binds.some((b) => isInsidePath(d, b)))
    // What lies inside another mask is hidden already.
    .filter((d, _i, all) => !all.some((o) => o !== d && isInsidePath(o, d)));
  return { protected: protectedPaths, masks, ro_binds };
}

/** A host that hides and adds nothing (tests, a core built without a daemon). */
export const NO_HOST: SandboxHost = { protected: [], masks: [], ro_binds: [] };

/**
 * What a host path is, for the argv builder: absent, a symlink (with its target), a
 * directory or anything else that exists (`file`: a regular file, a socket).
 */
export type PathProbe = (
  path: string,
) => { kind: 'symlink'; target: string } | { kind: 'dir' } | { kind: 'file' } | undefined;

export const probePath: PathProbe = (path) => {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      return { kind: 'symlink', target: readlinkSync(path) };
    }
    return st.isDirectory() ? { kind: 'dir' } : { kind: 'file' };
  } catch {
    return undefined;
  }
};

export interface SandboxArgvOptions {
  sandbox: SandboxConfig;
  /** The rendered command (argv). */
  cmd: readonly string[];
  /**
   * The one directory bound read-write: a shell action's `cwd`, the agents' `work_dir`.
   * Without one nothing but the private `/tmp` is writable.
   */
  writable: string | undefined;
  /** Working directory inside the sandbox; defaults to `writable`, else the private `/tmp`. */
  cwd?: string | undefined;
  /** `HOME` inside the sandbox; defaults to `cwd`. */
  home?: string | undefined;
  /** The rendered action `env` (or the agent's). */
  env: Readonly<Record<string, string>>;
  /** What the daemon hides and adds on this host; nothing by default. */
  host?: SandboxHost | undefined;
  /** Where `PATH` and `LANG` come from; defaults to the daemon's environment. */
  hostEnv?: NodeJS.ProcessEnv | undefined;
  /**
   * Cuts the sandbox off the host's network (`--unshare-net`); with a `proxySocket`, binds
   * it in and runs `cmd` behind the bridge that serves it as the HTTP proxy. Absent: the
   * host's network is shared.
   */
  net?: SandboxNet | undefined;
  /** Filesystem probe; tests pass a stub. */
  probe?: PathProbe | undefined;
}

/**
 * The full argv (`bwrap`, its options, `--`, the command) that runs `cmd` in the sandbox.
 * Pure: it never touches the filesystem beyond `probe`. On a merged-`/usr` system `/bin`
 * and `/lib` are symlinks and are recreated as such rather than bind-mounted. Mount order
 * matters to bwrap (a later mount on an ancestor shadows an earlier one on a descendant):
 * the OS and the install first, then the host's masks over them and `/dev/null` over any
 * protected file those mounts would still show, then the writable directory and the
 * config's own binds, which may lie inside a mask but, by `oa validate` (`checkSandboxes`),
 * never contain a protected path, and last the proxy socket of a sandbox with a network
 * allowlist, in the private `/tmp`.
 */
export function buildSandboxArgv(opts: SandboxArgvOptions): string[] {
  const probe = opts.probe ?? probePath;
  const hostEnv = opts.hostEnv ?? process.env;
  const host = opts.host ?? NO_HOST;
  const cwd = opts.cwd ?? opts.writable ?? SANDBOX_DEFAULT_CWD;
  const home = opts.home ?? cwd;
  const argv: string[] = [
    'bwrap',
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
    '--new-session',
  ];
  if (opts.net !== undefined) {
    argv.push('--unshare-net');
  }
  for (const path of BASE_RO_PATHS) {
    const p = probe(path);
    if (p === undefined) {
      continue;
    }
    if (p.kind === 'symlink') {
      argv.push('--symlink', p.target, path);
    } else {
      argv.push('--ro-bind', path, path);
    }
  }
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const path of host.ro_binds) {
    if (probe(path)?.kind === 'dir') {
      argv.push('--ro-bind', path, path);
    }
  }
  for (const path of host.masks) {
    if (probe(path)?.kind === 'dir') {
      argv.push('--tmpfs', path);
    }
  }
  for (const p of host.protected) {
    const shown = underBase(p.path) || host.ro_binds.some((b) => isInsidePath(b, p.path));
    if (
      shown &&
      !host.masks.some((m) => isInsidePath(m, p.path)) &&
      probe(p.path)?.kind === 'file'
    ) {
      argv.push('--ro-bind', '/dev/null', p.path);
    }
  }
  if (opts.writable !== undefined) {
    argv.push('--bind', opts.writable, opts.writable);
  }
  for (const path of opts.sandbox.ro_binds) {
    argv.push('--ro-bind', path, path);
  }
  for (const path of opts.sandbox.rw_binds) {
    argv.push('--bind', path, path);
  }
  const proxySocket = opts.net?.proxySocket;
  if (proxySocket !== undefined) {
    argv.push('--ro-bind', proxySocket, SANDBOX_NET_SOCKET);
  }
  argv.push('--chdir', cwd, '--clearenv');
  const env: Record<string, string> = {
    PATH: hostEnv.PATH ?? DEFAULT_PATH,
    HOME: home,
    ...(hostEnv.LANG === undefined ? {} : { LANG: hostEnv.LANG }),
    ...opts.env,
  };
  for (const [key, value] of Object.entries(env)) {
    argv.push('--setenv', key, value);
  }
  argv.push(...opts.sandbox.extra_args, '--');
  if (proxySocket !== undefined) {
    const node = opts.net?.execPath ?? process.execPath;
    argv.push(node, '-e', NET_BRIDGE_SOURCE, '--', SANDBOX_NET_SOCKET);
  }
  argv.push(...opts.cmd);
  return argv;
}
