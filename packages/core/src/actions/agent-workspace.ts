import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { execa } from 'execa';
import { z } from 'zod';

import { NonRetryableError } from './types.js';

/**
 * Where an `agent` run works (docs/internal/agent-action.md): a fresh git worktree of `repo` at
 * `branch` on its own `agent/<run_id>` branch, or an empty directory. Either lives at
 * `<work_dir>/<run_id>`, is removed when the run fails and kept when it succeeds (for
 * `post` gates, `${run.workspace}` and inspection) until the retention pass sweeps it
 * (`listWorkspaces` + `removeWorkspaceDir`, driven by `retention.workspaces`).
 */
export const Workspace = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('git-worktree'),
    /** Absolute path of the base checkout. */
    repo: z.string().min(1),
    branch: z.string().min(1).default('main'),
  }),
  z.strictObject({ kind: z.literal('temp') }),
]);

export type WorkspaceConfig = z.infer<typeof Workspace>;

export interface WorkspaceHandle {
  readonly path: string;
  /**
   * Throws `NonRetryableError` when the agent changed what makes the directory a workspace
   * of the configured repository: the `.git` pointer a worktree was created with. Anything
   * git runs there afterwards (a `post` gate) would otherwise take hooks and configuration
   * from a repository the agent wrote. A `temp` workspace has nothing to check.
   */
  assertIntact(): void;
  /** Deletes the directory (and the worktree's branch). Never throws. */
  remove(): Promise<void>;
}

/**
 * Git configuration every git the daemon runs on an agent's behalf carries, as `-c` pairs
 * for its own commands (`git()`) and as `GIT_CONFIG_*` for a `post` gate's: no hooks and
 * no fsmonitor program, whatever the repository or the workspace configures. Both are
 * commands git would run as the daemon user, from files the agent can write
 * (docs/internal/security.md).
 */
const GIT_NO_PROGRAMS: readonly [string, string][] = [
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
];

/** The environment that applies `GIT_NO_PROGRAMS` to any git a `post` gate runs. */
export function gitNoProgramsEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(GIT_NO_PROGRAMS.length) };
  GIT_NO_PROGRAMS.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${String(i)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(i)}`] = value;
  });
  return env;
}

/** The path a run's workspace has, whether or not it exists yet. */
export function workspacePath(workDir: string, runId: string): string {
  return join(workDir, runId);
}

async function git(args: string[], cwd?: string): Promise<void> {
  const safe = GIT_NO_PROGRAMS.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  const r = await execa('git', [...safe, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    reject: false,
    stripFinalNewline: true,
  });
  if (r.exitCode !== 0) {
    const tail = r.stderr.trim().split('\n').slice(-3).join(' ');
    throw new NonRetryableError(
      `git ${args.slice(0, 3).join(' ')} failed (exit ${String(r.exitCode ?? '?')}): ${tail}`,
    );
  }
}

/** Creates the workspace; an existing directory from an earlier attempt is replaced. */
export async function createWorkspace(
  cfg: WorkspaceConfig,
  workDir: string,
  runId: string,
): Promise<WorkspaceHandle> {
  mkdirSync(workDir, { recursive: true });
  // The real path: an agent reports the paths it touches resolved (macOS's /var is
  // /private/var), and the policy compares them with this one.
  const path = workspacePath(realpathSync(workDir), runId);
  if (cfg.kind === 'temp') {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
    return {
      path,
      assertIntact: () => undefined,
      remove: () => {
        rmSync(path, { recursive: true, force: true });
        return Promise.resolve();
      },
    };
  }
  const repo = resolve(cfg.repo);
  const branch = `agent/${runId}`;
  await git(['-C', repo, 'worktree', 'remove', '--force', path]).catch(() => undefined);
  rmSync(path, { recursive: true, force: true });
  await git(['-C', repo, 'worktree', 'add', '-B', branch, path, cfg.branch]);
  const pointer = readFileSync(join(path, '.git'), 'utf8');
  return {
    path,
    assertIntact: () => {
      let current: string | undefined;
      try {
        if (lstatSync(join(path, '.git')).isFile()) {
          current = readFileSync(join(path, '.git'), 'utf8');
        }
      } catch {
        // missing: not intact either
      }
      if (current !== pointer) {
        throw new NonRetryableError(
          `the workspace's .git no longer points at the worktree of ${repo}: the agent replaced it`,
        );
      }
    },
    remove: async () => {
      await git(['-C', repo, 'worktree', 'remove', '--force', path]).catch(() => undefined);
      rmSync(path, { recursive: true, force: true });
      // `remove` refuses a directory that is no longer a worktree (the agent replaced its
      // `.git`); pruning the gone directory frees the branch for deletion either way.
      await git(['-C', repo, 'worktree', 'prune']).catch(() => undefined);
      await git(['-C', repo, 'branch', '-D', branch]).catch(() => undefined);
    },
  };
}

/** One `<work_dir>/<run_id>` directory as the retention sweep sees it. */
export interface WorkspaceEntry {
  runId: string;
  path: string;
  /** Last modification of the directory itself. */
  mtime: Date;
}

const RUN_DIR = /^run_[0-9A-Z]+$/;

/**
 * The run directories under `workDir` (only names shaped like run ids, so a mistyped
 * `work_dir` never gets swept). A missing `workDir` is an empty list.
 */
export function listWorkspaces(workDir: string): WorkspaceEntry[] {
  let names: string[];
  try {
    names = readdirSync(workDir);
  } catch {
    return [];
  }
  const out: WorkspaceEntry[] = [];
  for (const name of names) {
    if (!RUN_DIR.test(name)) {
      continue;
    }
    const path = join(workDir, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) {
        out.push({ runId: name, path, mtime: st.mtime });
      }
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

/**
 * The git directory of the repository a worktree at `path` belongs to (from its `.git`
 * file: `<git dir>/worktrees/<name>`), or undefined. A git directory rather than a working
 * tree, so a bare `repo` works too.
 */
function worktreeGitDir(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(path, '.git'), 'utf8');
  } catch {
    return undefined;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (m?.[1] === undefined) {
    return undefined;
  }
  const gitdir = isAbsolute(m[1]) ? m[1] : resolve(path, m[1]);
  return basename(dirname(gitdir)) === 'worktrees' ? dirname(dirname(gitdir)) : undefined;
}

/**
 * Removes a workspace left by a finished run the way `WorkspaceHandle.remove` would have:
 * a git worktree is detached from its repository and its `agent/<run_id>` branch deleted,
 * then the directory goes. Never throws.
 */
export async function removeWorkspaceDir(entry: WorkspaceEntry): Promise<void> {
  const gitDir = worktreeGitDir(entry.path);
  const inRepo = (args: string[]): Promise<unknown> =>
    git([`--git-dir=${gitDir ?? ''}`, ...args]).catch(() => undefined);
  if (gitDir !== undefined) {
    await inRepo(['worktree', 'remove', '--force', entry.path]);
  }
  rmSync(entry.path, { recursive: true, force: true });
  if (gitDir !== undefined) {
    await inRepo(['worktree', 'prune']);
    await inRepo(['branch', '-D', `agent/${entry.runId}`]);
  }
}
