import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { ConnectorConfig } from '../config/connector.js';
import type { TaskConfig } from '../config/schema.js';
import { taskActions } from '../config/walk.js';
import type { SandboxConfig } from './sandbox.js';

/**
 * Whether bubblewrap can start a sandbox on this host, as the daemon's own user, with
 * the namespaces every sandbox gets (`buildSandboxArgv`)
 * (docs/internal/security.md). The daemon runs it at start and on reload when anything is
 * configured with `sandbox: bwrap`, and logs `core.sandbox_unavailable` with the cause, so
 * an operator learns about a missing package or a host policy on user namespaces before
 * the first sandboxed run fails.
 */
export const BWRAP_PROBE_ARGV: readonly string[] = [
  'bwrap',
  '--unshare-pid',
  '--unshare-ipc',
  '--ro-bind',
  '/',
  '/',
  'true',
];

/** Runs the probe; tests pass a stub. */
export type ProbeRun = (
  argv: readonly string[],
) => Promise<{ status?: number | null; stderr?: string; error?: NodeJS.ErrnoException }>;

export type BwrapProbeResult = { ok: true } | { ok: false; cause: string };

export interface BwrapProbeOptions {
  run?: ProbeRun | undefined;
  /** A sysctl by its dotted name (`kernel.unprivileged_userns_clone`); undefined when absent. */
  readSysctl?: ((name: string) => string | undefined) | undefined;
}

const PROBE_TIMEOUT_MS = 10_000;

const defaultRun: ProbeRun = (argv) =>
  new Promise((resolve) => {
    execFile(
      argv[0] ?? 'bwrap',
      argv.slice(1),
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
      (err, _stdout, stderr) => {
        if (err === null) {
          resolve({ status: 0, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: unknown };
        // A spawn failure has a string code (ENOENT, EACCES); an exit has a numeric one.
        if (typeof e.code === 'string') {
          resolve({ error: e });
          return;
        }
        const killed = (e as { killed?: boolean }).killed === true;
        resolve({
          status: typeof e.code === 'number' ? e.code : null,
          stderr: killed
            ? `timed out after ${String(PROBE_TIMEOUT_MS / 1000)} s`
            : stderr || e.message,
        });
      },
    );
  });

const defaultReadSysctl = (name: string): string | undefined => {
  try {
    return readFileSync(`/proc/sys/${name.replaceAll('.', '/')}`, 'utf8').trim();
  } catch {
    return undefined;
  }
};

const MANUAL = `check by hand as the service user: ${BWRAP_PROBE_ARGV.join(' ')}`;

/** Runs `BWRAP_PROBE_ARGV` and, when it fails, names the most likely cause. */
export async function probeBwrap(opts: BwrapProbeOptions = {}): Promise<BwrapProbeResult> {
  const run = opts.run ?? defaultRun;
  const sysctl = opts.readSysctl ?? defaultReadSysctl;
  const r = await run(BWRAP_PROBE_ARGV);
  if (r.error !== undefined) {
    if (r.error.code === 'ENOENT') {
      return {
        ok: false,
        cause: 'bwrap is not installed or not on PATH: apt install bubblewrap',
      };
    }
    return { ok: false, cause: `bwrap could not be started: ${r.error.message}; ${MANUAL}` };
  }
  if (r.status === 0) {
    return { ok: true };
  }
  const said = (r.stderr ?? '').trim() || `exit status ${String(r.status)}`;
  let why: string;
  // Only a failure to create the user namespace points at the host's userns policy.
  const userns = /uid map|No permissions to creat|Operation not permitted|Permission denied/.test(
    said,
  );
  if (!userns) {
    why = MANUAL;
  } else if (sysctl('kernel.apparmor_restrict_unprivileged_userns') === '1') {
    why =
      'AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1, the Ubuntu 23.10+ default): add an AppArmor profile for bwrap that allows userns';
  } else if (sysctl('kernel.unprivileged_userns_clone') === '0') {
    why = 'unprivileged user namespaces are off (kernel.unprivileged_userns_clone=0): set it to 1';
  } else if (sysctl('user.max_user_namespaces') === '0') {
    why = 'user namespaces are off (user.max_user_namespaces=0): raise it';
  } else {
    why = MANUAL;
  }
  return { ok: false, cause: `bwrap cannot start a sandbox (${said}); ${why}` };
}

/**
 * What runs in bwrap under this config, as `task <name>` and `connector <name>`: tasks with
 * a `shell` action (their own or a sequence step's) whose sandbox, or else
 * `defaults.sandbox`, is bwrap, and `acp` connectors with a bwrap sandbox.
 */
export function bwrapUsers(
  tasks: readonly TaskConfig[],
  defaultSandbox: SandboxConfig | undefined,
  manifests: readonly ConnectorConfig[],
): string[] {
  const users: string[] = [];
  for (const task of tasks) {
    const boxed = taskActions(task, 'action').some(
      ({ action }) =>
        action.kind === 'shell' && (action.sandbox ?? defaultSandbox)?.backend === 'bwrap',
    );
    if (boxed) {
      users.push(`task ${task.name}`);
    }
  }
  for (const m of manifests) {
    if (m.transport === 'acp' && m.sandbox?.backend === 'bwrap') {
      users.push(`connector ${m.name}`);
    }
  }
  return users;
}
