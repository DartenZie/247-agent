import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { z } from 'zod';

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

/** `sandbox: bwrap` or `sandbox: { backend: bwrap, ro_binds: [...], ... }`. */
export const Sandbox = z.union([
  Backend.transform((backend) => ({ backend, extra_args: [], ro_binds: [], rw_binds: [] })),
  SandboxObject,
]);

export type SandboxConfig = z.infer<typeof SandboxObject>;
export type SandboxBackend = z.infer<typeof Backend>;

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

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** Inside one of the base read-only paths, so already visible; or one of them. */
function underBase(path: string): boolean {
  return BASE_RO_PATHS.some((b) => isInsidePath(b, path));
}

/** A directory that can be replaced by an empty tmpfs without taking the OS with it. */
function maskable(path: string): boolean {
  return path !== '/' && !BASE_RO_PATHS.some((b) => isInsidePath(path, b));
}

/**
 * What every sandbox on this host hides and shows, fixed for the daemon's lifetime
 * (ARCHITECTURE §11). `masks` are directories replaced by an empty tmpfs so the daemon's
 * own files never show through the read-only `/etc` or a wide bind: the directories of
 * the config file (tasks, manifests, prompts, a `file` secrets backend), the database and
 * the socket. `ro_binds` are what a child needs to run at all: the install root
 * (`OA_HOME`: `bin/` and the bundled connectors) and the prefix of the daemon's Node
 * (`node`, `npm`, `npx`), since both are first on the `PATH` every child gets. Both lists
 * hold canonical paths; a mask is skipped when it is `/` or would cover an OS directory.
 */
export interface SandboxHost {
  /** Files that must stay out of every sandbox: the db, the socket, `agent.yaml`, the secrets file. */
  readonly protected: readonly ProtectedPath[];
  readonly masks: readonly string[];
  readonly ro_binds: readonly string[];
}

/** One file the daemon keeps out of every sandbox, with what to call it in a message. */
export interface ProtectedPath {
  path: string;
  /** `database`, `socket`, `config file`, `secrets file`. */
  what: string;
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
  const protectedPaths = opts.protected.map((p) => ({ ...p, path: canonical(p.path) }));
  const masks = unique(protectedPaths.map((p) => dirname(p.path))).filter(maskable);
  const home = env.OA_HOME;
  const nodePrefix = dirname(dirname(canonical(opts.execPath ?? process.execPath)));
  const wanted = unique([
    ...(home === undefined || home === '' ? [] : [canonical(home)]),
    nodePrefix,
  ]).filter((p) => p !== '/' && !underBase(p));
  // The Node prefix of a release tree lives inside the install root: one bind is enough.
  const ro_binds = wanted.filter((p, i) => !wanted.some((q, j) => j !== i && isInsidePath(q, p)));
  return { protected: protectedPaths, masks, ro_binds };
}

/** A host that hides and adds nothing (tests, a core built without a daemon). */
export const NO_HOST: SandboxHost = { protected: [], masks: [], ro_binds: [] };

/** What a host path is, for the argv builder: absent, a symlink (with its target) or a directory. */
export type PathProbe = (
  path: string,
) => { kind: 'symlink'; target: string } | { kind: 'dir' } | undefined;

export const probePath: PathProbe = (path) => {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      return { kind: 'symlink', target: readlinkSync(path) };
    }
    return st.isDirectory() ? { kind: 'dir' } : undefined;
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
  /** Filesystem probe; tests pass a stub. */
  probe?: PathProbe | undefined;
}

/**
 * The full argv (`bwrap`, its options, `--`, the command) that runs `cmd` in the sandbox.
 * Pure: it never touches the filesystem beyond `probe`. On a merged-`/usr` system `/bin`
 * and `/lib` are symlinks and are recreated as such rather than bind-mounted. Mount order
 * matters to bwrap (a later mount on an ancestor shadows an earlier one on a descendant):
 * the OS and the install first, then the host's masks over them, then the writable
 * directory and the config's own binds, which may lie inside a mask but, by `oa validate`,
 * never contain a protected path.
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
  if (opts.writable !== undefined) {
    argv.push('--bind', opts.writable, opts.writable);
  }
  for (const path of opts.sandbox.ro_binds) {
    argv.push('--ro-bind', path, path);
  }
  for (const path of opts.sandbox.rw_binds) {
    argv.push('--bind', path, path);
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
  argv.push(...opts.sandbox.extra_args, '--', ...opts.cmd);
  return argv;
}
