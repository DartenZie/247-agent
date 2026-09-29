import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { execa } from 'execa';
import { z } from 'zod';

import { NonRetryableError } from './types.js';

/**
 * Where an `agent` run works (ARCHITECTURE §5.4): a fresh git worktree of `repo` at
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
  /** Deletes the directory (and the worktree's branch). Never throws. */
  remove(): Promise<void>;
}

/** The path a run's workspace has, whether or not it exists yet. */
export function workspacePath(workDir: string, runId: string): string {
  return join(workDir, runId);
}

async function git(args: string[], cwd?: string): Promise<void> {
  const r = await execa('git', args, {
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
  const path = workspacePath(workDir, runId);
  mkdirSync(workDir, { recursive: true });
  if (cfg.kind === 'temp') {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
    return {
      path,
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
  return {
    path,
    remove: async () => {
      await git(['-C', repo, 'worktree', 'remove', '--force', path]).catch(() => undefined);
      rmSync(path, { recursive: true, force: true });
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

/** The base repository of a git worktree at `path` (from its `.git` file), or undefined. */
function worktreeRepo(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(path, '.git'), 'utf8');
  } catch {
    return undefined;
  }
  const m = /^gitdir:\s*(.+)\s*$/m.exec(text);
  if (m?.[1] === undefined) {
    return undefined;
  }
  // `<repo>/.git/worktrees/<name>`
  const gitdir = isAbsolute(m[1]) ? m[1] : resolve(path, m[1]);
  const dotGit = dirname(dirname(gitdir));
  return dotGit.endsWith('.git') ? dirname(dotGit) : undefined;
}

/**
 * Removes a workspace left by a finished run the way `WorkspaceHandle.remove` would have:
 * a git worktree is detached from its repository and its `agent/<run_id>` branch deleted,
 * then the directory goes. Never throws.
 */
export async function removeWorkspaceDir(entry: WorkspaceEntry): Promise<void> {
  const repo = worktreeRepo(entry.path);
  if (repo !== undefined) {
    await git(['-C', repo, 'worktree', 'remove', '--force', entry.path]).catch(() => undefined);
  }
  rmSync(entry.path, { recursive: true, force: true });
  if (repo !== undefined) {
    await git(['-C', repo, 'worktree', 'prune']).catch(() => undefined);
    await git(['-C', repo, 'branch', '-D', `agent/${entry.runId}`]).catch(() => undefined);
  }
}
