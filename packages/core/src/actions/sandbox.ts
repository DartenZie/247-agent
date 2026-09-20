import { lstatSync, readlinkSync } from 'node:fs';

import { z } from 'zod';

/**
 * Sandbox for `shell` actions (ARCHITECTURE §5.1, §11). `none` runs the command as the
 * daemon itself. `bwrap` wraps it in bubblewrap: its own pid and ipc namespaces, a
 * read-only view of the OS (`/usr`, `/lib`, `/lib64`, `/bin`, `/etc`), a private `/tmp`,
 * the action's `cwd` as the only writable path, and an environment that holds nothing
 * but the action's `env` plus `PATH`, `HOME` and `LANG`. The daemon's runtime directory
 * (the core socket), its state directory and `/proc` of other processes are not visible.
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

/** Host directories the sandbox sees read-only, when they exist. */
export const BASE_RO_PATHS = ['/usr', '/lib', '/lib64', '/bin', '/etc'] as const;

/** Working directory inside the sandbox when the action declares no `cwd`. */
export const SANDBOX_DEFAULT_CWD = '/tmp';

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

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
  /** The rendered `cwd`; without one the command runs in the private `/tmp`. */
  cwd: string | undefined;
  /** The rendered action `env`. */
  env: Readonly<Record<string, string>>;
  /** Where `PATH` and `LANG` come from; defaults to the daemon's environment. */
  hostEnv?: NodeJS.ProcessEnv;
  /** Filesystem probe; tests pass a stub. */
  probe?: PathProbe;
}

/**
 * The full argv (`bwrap`, its options, `--`, the command) that runs `cmd` in the sandbox.
 * Pure: it never touches the filesystem beyond `probe`. On a merged-`/usr` system `/bin`
 * and `/lib` are symlinks and are recreated as such rather than bind-mounted.
 */
export function buildSandboxArgv(opts: SandboxArgvOptions): string[] {
  const probe = opts.probe ?? probePath;
  const host = opts.hostEnv ?? process.env;
  const cwd = opts.cwd ?? SANDBOX_DEFAULT_CWD;
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
  if (opts.cwd !== undefined) {
    argv.push('--bind', opts.cwd, opts.cwd);
  }
  for (const path of opts.sandbox.ro_binds) {
    argv.push('--ro-bind', path, path);
  }
  for (const path of opts.sandbox.rw_binds) {
    argv.push('--bind', path, path);
  }
  argv.push('--chdir', cwd, '--clearenv');
  const env: Record<string, string> = {
    PATH: host.PATH ?? DEFAULT_PATH,
    HOME: cwd,
    ...(host.LANG === undefined ? {} : { LANG: host.LANG }),
    ...opts.env,
  };
  for (const [key, value] of Object.entries(env)) {
    argv.push('--setenv', key, value);
  }
  argv.push(...opts.sandbox.extra_args, '--', ...opts.cmd);
  return argv;
}
