import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execaSync } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBus } from './bus/bus.js';
import { retentionPolicy } from './config/retention.js';
import { createLogger } from './log.js';
import { Metrics } from './metrics.js';
import { RetentionJob } from './retention.js';
import { scrubEnv } from './secrets/secrets.js';
import { openStore, type Store } from './store/store.js';
import type { RunStatus } from './store/types.js';

const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

let dir: string;
let store: Store;
let lines: Record<string, unknown>[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-retjob-'));
  store = openStore(join(dir, 'state.db'));
  lines = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function run(id: string, status: RunStatus, finishedAt: Date | undefined): void {
  store.events.insert({
    id: `evt_${id}`,
    type: 'x.y',
    source: 'test',
    ts: ago(60).toISOString(),
    correlation_id: `cor_${id}`,
    parent_id: null,
    dedup_key: null,
    depth: 0,
    payload: null,
  });
  store.runs.insertQueued({
    id,
    task: 't',
    event_id: `evt_${id}`,
    correlation_id: `cor_${id}`,
    created_at: ago(60).toISOString(),
  });
  store.runs.setStatus(id, status, {
    ...(finishedAt === undefined ? {} : { finished_at: finishedAt.toISOString() }),
  });
}

function workspace(workDir: string, name: string, mtime: Date): string {
  const path = join(workDir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'f.txt'), 'x');
  utimesSync(path, mtime, mtime);
  return path;
}

const job = (workDir: string | undefined, metrics = new Metrics()): RetentionJob => {
  const clock = { now: () => NOW };
  const log = createLogger({
    level: 'debug',
    sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });
  return new RetentionJob({
    store,
    bus: createBus({ store, clock, log, metrics }),
    clock,
    log,
    metrics,
    policy: retentionPolicy({
      events: '90d',
      runs: '30d',
      workspaces: '7d',
      interval: '1h',
    }),
    workDir,
    env: scrubEnv(process.env),
  });
};

const keptEvents = (): ReturnType<Store['events']['list']> =>
  store.events.list({ type: 'retention.workspace_kept' });

describe('RetentionJob', () => {
  it('sweeps workspaces of old finished runs and orphans, keeps active and recent ones', async () => {
    const workDir = join(dir, 'work');
    run('run_OLDDONE', 'succeeded', ago(8));
    run('run_RECENT', 'succeeded', ago(1));
    run('run_ACTIVE', 'running', undefined);
    run('run_WAITING', 'waiting', undefined);
    const oldDone = workspace(workDir, 'run_OLDDONE', ago(1)); // mtime is irrelevant when the run is known
    const recent = workspace(workDir, 'run_RECENT', ago(30));
    const active = workspace(workDir, 'run_ACTIVE', ago(30));
    const waiting = workspace(workDir, 'run_WAITING', ago(30));
    const orphanOld = workspace(workDir, 'run_ORPHANOLD', ago(8));
    const orphanNew = workspace(workDir, 'run_ORPHANNEW', ago(6));
    const foreign = workspace(workDir, 'not-a-run', ago(100));

    const metrics = new Metrics();
    const report = await job(workDir, metrics).run();
    expect(report).toMatchObject({ runs: 0, ledger: 0, transcripts: 0, events: 0, workspaces: 2 });
    expect(existsSync(oldDone)).toBe(false);
    expect(existsSync(orphanOld)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(waiting)).toBe(true);
    expect(existsSync(orphanNew)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(lines.filter((l) => l.msg === 'retention.workspace_removed')).toHaveLength(2);
    expect(lines.find((l) => l.msg === 'retention.purged')).toMatchObject({
      level: 'info',
      workspaces: 2,
    });
    expect(metrics.registry.value('oa_retention_deleted_total', { kind: 'workspaces' })).toBe(2);
    expect(metrics.registry.value('oa_retention_runs_total', { result: 'ok' })).toBe(1);
    expect(metrics.render()).toMatch(/oa_retention_last_success_timestamp_seconds \d+/);
  });

  it('detaches a git worktree and deletes its branch when sweeping it', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]): string => execaSync('git', args, { cwd: repo }).stdout;
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@x');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const workDir = join(dir, 'work');
    mkdirSync(workDir);
    const ws = join(workDir, 'run_WT');
    git('worktree', 'add', '-q', '-B', 'agent/run_WT', ws, 'main');
    run('run_WT', 'succeeded', ago(10));

    const report = await job(workDir).run();
    expect(report?.workspaces).toBe(1);
    expect(existsSync(ws)).toBe(false);
    expect(git('worktree', 'list')).not.toContain(ws);
    expect(git('branch', '--list', 'agent/run_WT')).toBe('');
    expect(git('log', '-1', '--format=%s')).toBe('init'); // the base checkout is untouched
  });

  it('keeps a git worktree whose branch holds a commit not yet pushed', async () => {
    const origin = join(dir, 'origin.git');
    execaSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]): string => execaSync('git', args, { cwd }).stdout;
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@x');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    const workDir = join(dir, 'work');
    mkdirSync(workDir);
    const ws = join(workDir, 'run_WT');
    git(repo, 'worktree', 'add', '-q', '-B', 'agent/run_WT', ws, 'main');
    writeFileSync(join(ws, 'a.txt'), 'two\n');
    git(ws, 'commit', '-q', '-am', 'change');
    run('run_WT', 'succeeded', ago(10));

    const metrics = new Metrics();
    const kept = await job(workDir, metrics).run();
    expect(kept?.workspaces).toBe(0);
    expect(metrics.registry.value('oa_retention_workspaces_kept')).toBe(1);
    expect(existsSync(ws)).toBe(true);
    expect(git(repo, 'branch', '--list', 'agent/run_WT')).not.toBe('');
    expect(lines.find((l) => l.msg === 'retention.workspace_kept')).toMatchObject({
      run_id: 'run_WT',
      path: ws,
      reason: 'unpushed',
      commits: 1,
    });
    expect(keptEvents()).toMatchObject([
      {
        source: 'core',
        dedup_key: 'retention.workspace_kept:run_WT',
        parent_id: null,
        payload: { run_id: 'run_WT', task: 't', path: ws, reason: 'unpushed', commits: 1 },
      },
    ]);
    await job(workDir).run(); // a second pass keeps it again but does not publish again
    expect(keptEvents()).toHaveLength(1);

    git(ws, 'push', '-q', 'origin', 'HEAD:main');
    const swept = await job(workDir).run();
    expect(swept?.workspaces).toBe(1);
    expect(existsSync(ws)).toBe(false);
    expect(git(repo, 'branch', '--list', 'agent/run_WT')).toBe('');
  });

  it('keeps a git worktree when git cannot count its unpushed commits', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]): string => execaSync('git', args, { cwd }).stdout;
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'user.email', 't@x');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const workDir = join(dir, 'work');
    mkdirSync(workDir);
    const ws = join(workDir, 'run_WT');
    git(repo, 'worktree', 'add', '-q', '-B', 'agent/run_WT', ws, 'main');
    writeFileSync(join(ws, 'a.txt'), 'two\n');
    git(ws, 'commit', '-q', '-am', 'change');
    // A missing object makes the walk fail: the base commit is gone from the store.
    const base = git(repo, 'rev-parse', 'main');
    rmSync(join(repo, '.git', 'objects', base.slice(0, 2), base.slice(2)));
    run('run_WT', 'succeeded', ago(10));

    const report = await job(workDir).run();
    expect(report?.workspaces).toBe(0);
    expect(existsSync(ws)).toBe(true);
    expect(lines.find((l) => l.msg === 'retention.workspace_kept')).toMatchObject({
      run_id: 'run_WT',
      reason: 'unknown',
    });
    expect(keptEvents()).toHaveLength(1);
    expect(keptEvents()[0]?.payload).toEqual({
      run_id: 'run_WT',
      task: 't',
      path: ws,
      reason: 'unknown',
    });
  });

  it('does nothing to workspaces without a work dir, runs on start and stops cleanly', async () => {
    run('run_X', 'succeeded', ago(40));
    const j = job(undefined);
    j.start();
    await j.run(); // joins the pass start() kicked off
    expect(store.runs.getById('run_X')).toBeUndefined();
    await j.stop();
    expect(lines.filter((l) => l.msg === 'retention.purged')).toHaveLength(1);
  });

  it('logs and counts a failing pass instead of throwing', async () => {
    const metrics = new Metrics();
    const j = job(undefined, metrics);
    store.close();
    expect(await j.run()).toBeUndefined();
    expect(lines.find((l) => l.msg === 'retention.failed')).toBeDefined();
    expect(metrics.registry.value('oa_retention_runs_total', { result: 'failed' })).toBe(1);
    store = openStore(join(dir, 'state.db')); // for afterEach
  });
});
