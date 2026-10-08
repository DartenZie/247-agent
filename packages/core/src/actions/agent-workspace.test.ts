import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execaSync } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspace, listWorkspaces, removeWorkspaceDir } from './agent-workspace.js';

/** A base checkout with one commit on `main` and an identity in its config, for worktrees. */
function seedRepo(repo: string): string {
  mkdirSync(repo);
  const git = (...args: string[]): void => {
    execaSync('git', args, { cwd: repo });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@x');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return repo;
}

/** A git hook that records that it ran in `marker` and then fails. */
function plantHook(path: string, marker: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n: > "${marker}"\nexit 1\n`, { mode: 0o755 });
}

const git = (cwd: string, ...args: string[]): string => execaSync('git', args, { cwd }).stdout;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-ws-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createWorkspace', () => {
  it('puts the workspace under the real path of a symlinked work_dir', async () => {
    const real = join(root, 'real');
    mkdirSync(real);
    const link = join(root, 'link');
    symlinkSync(real, link);
    const ws = await createWorkspace({ kind: 'temp' }, link, 'run_01TEST');
    expect(ws.path).toBe(join(realpathSync(real), 'run_01TEST'));
    expect(existsSync(ws.path)).toBe(true);
    await ws.remove();
    expect(existsSync(ws.path)).toBe(false);
  });

  it('creates and removes a worktree without running the repository hooks', async () => {
    const repo = seedRepo(join(root, 'repo'));
    const hookRan = join(root, 'hook-ran');
    plantHook(join(repo, '.git', 'hooks', 'reference-transaction'), hookRan);
    const cfg = { kind: 'git-worktree' as const, repo, branch: 'main' };
    const ws = await createWorkspace(cfg, join(root, 'work'), 'run_01TEST');
    expect(git(repo, 'branch', '--list', 'agent/run_01TEST')).toContain('agent/run_01TEST');
    expect(existsSync(hookRan)).toBe(false);
    await ws.remove();
    expect(existsSync(ws.path)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(ws.path);
    expect(git(repo, 'branch', '--list', 'agent/run_01TEST')).toBe('');
    expect(existsSync(hookRan)).toBe(false);
  });
});

describe('removeWorkspaceDir', () => {
  it('sweeps a workspace whose .git the agent pointed at its own git directory, without running its hooks', async () => {
    const repo = seedRepo(join(root, 'repo'));
    const workDir = join(root, 'work');
    const ws = await createWorkspace(
      { kind: 'git-worktree', repo, branch: 'main' },
      workDir,
      'run_01TEST',
    );
    // The agent builds a git directory of its own that outlives the workspace, gives it the
    // branch the sweep will delete and a hook on reference updates, and repoints `.git` at it.
    const planted = join(root, 'planted');
    git(root, 'init', '-q', '--bare', planted);
    const tree = git(root, `--git-dir=${planted}`, 'mktree');
    const commit = git(
      root,
      `--git-dir=${planted}`,
      '-c',
      'user.name=a',
      '-c',
      'user.email=a@x',
      'commit-tree',
      tree,
      '-m',
      'x',
    );
    git(root, `--git-dir=${planted}`, 'update-ref', 'refs/heads/agent/run_01TEST', commit);
    const hookRan = join(root, 'hook-ran');
    plantHook(join(planted, 'hooks', 'reference-transaction'), hookRan);
    mkdirSync(join(planted, 'worktrees', 'run_01TEST'), { recursive: true });
    writeFileSync(join(ws.path, '.git'), `gitdir: ${join(planted, 'worktrees', 'run_01TEST')}\n`);

    const entries = listWorkspaces(workDir);
    expect(entries.map((e) => e.runId)).toEqual(['run_01TEST']);
    for (const entry of entries) {
      await removeWorkspaceDir(entry);
    }
    expect(existsSync(ws.path)).toBe(false);
    expect(existsSync(hookRan)).toBe(false);
  });
});
