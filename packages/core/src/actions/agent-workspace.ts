import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { z } from 'zod';

import { NonRetryableError } from './types.js';

/**
 * Where an `agent` run works (ARCHITECTURE §5.4): a fresh git worktree of `repo` at
 * `branch` on its own `agent/<run_id>` branch, or an empty directory. Either lives at
 * `<work_dir>/<run_id>`, is removed when the run fails and kept when it succeeds (for
 * `post` gates, `${run.workspace}` and inspection; retention GC is a follow-up).
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
