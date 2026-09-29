import {
  listWorkspaces,
  removeWorkspaceDir,
  type WorkspaceEntry,
} from './actions/agent-workspace.js';
import type { Clock } from './clock.js';
import type { RetentionPolicy } from './config/retention.js';
import type { Logger } from './log.js';
import { Metrics } from './metrics.js';
import { purgeStore, type PurgeCounts } from './store/retention.js';
import type { Store } from './store/store.js';
import { ACTIVE_STATUSES } from './store/types.js';

export interface RetentionOptions {
  store: Store;
  clock: Clock;
  log: Logger;
  policy: RetentionPolicy;
  /** `<work_dir>` of agent runs; without it no workspace is swept. */
  workDir?: string | undefined;
  metrics?: Metrics | undefined;
}

export interface RetentionReport extends PurgeCounts {
  workspaces: number;
  duration_ms: number;
}

/**
 * The retention pass (ARCHITECTURE §7, `retention:`): once at start and then every
 * `interval`, delete what the policy says is old: finished runs with their ledger rows,
 * stale ledger rows, dispatched events nothing references, and `work/<run_id>` directories
 * of runs finished long enough ago (or of no run at all). Workspaces of runs still queued,
 * running or waiting are never touched. Errors are logged, counted and retried next time.
 */
export class RetentionJob {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private policy: RetentionPolicy;
  private workDir: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<RetentionReport | undefined> | undefined;
  private stopped = true;

  constructor(opts: RetentionOptions) {
    this.store = opts.store;
    this.clock = opts.clock;
    this.log = opts.log;
    this.metrics = opts.metrics ?? new Metrics();
    this.policy = opts.policy;
    this.workDir = opts.workDir;
  }

  /** Arms the timer and runs a first pass in the background. */
  start(): void {
    this.stopped = false;
    this.arm();
    void this.run();
  }

  /** A new policy (reload): the timer is re-armed, a pass is not forced. */
  configure(policy: RetentionPolicy, workDir: string | undefined): void {
    this.policy = policy;
    this.workDir = workDir;
    if (!this.stopped) {
      this.arm();
    }
  }

  /** Disarms the timer and waits for a pass in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  /** One pass now; a pass already running is awaited instead. Never throws. */
  run(): Promise<RetentionReport | undefined> {
    this.inFlight ??= this.runOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private arm(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      void this.run();
    }, this.policy.intervalMs);
    this.timer.unref();
  }

  private async runOnce(): Promise<RetentionReport | undefined> {
    const startedAt = Date.now();
    try {
      const now = this.clock.now();
      const counts = purgeStore(this.store, now, this.policy);
      const workspaces = await this.sweepWorkspaces(now);
      const report: RetentionReport = {
        ...counts,
        workspaces,
        duration_ms: Date.now() - startedAt,
      };
      this.metrics.retentionDeleted.inc({ kind: 'runs' }, counts.runs);
      this.metrics.retentionDeleted.inc({ kind: 'ledger' }, counts.ledger);
      this.metrics.retentionDeleted.inc({ kind: 'events' }, counts.events);
      this.metrics.retentionDeleted.inc({ kind: 'workspaces' }, workspaces);
      this.metrics.retentionRuns.inc({ result: 'ok' });
      this.metrics.retentionLastSuccess.set(undefined, Math.floor(now.getTime() / 1000));
      const level = counts.runs + counts.ledger + counts.events + workspaces > 0 ? 'info' : 'debug';
      this.log[level]('retention.purged', { ...report });
      return report;
    } catch (err) {
      this.metrics.retentionRuns.inc({ result: 'failed' });
      this.log.error('retention.failed', {
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startedAt,
      });
      return undefined;
    }
  }

  /**
   * A directory goes when its run finished before the cutoff, or when it has no run at all
   * and was last modified before the cutoff (its run was purged, or a crash left it).
   */
  private async sweepWorkspaces(now: Date): Promise<number> {
    const ms = this.policy.workspacesMs;
    if (ms === undefined || this.workDir === undefined) {
      return 0;
    }
    const cutoff = now.getTime() - ms;
    let removed = 0;
    for (const entry of listWorkspaces(this.workDir)) {
      if (!this.stale(entry, cutoff)) {
        continue;
      }
      await removeWorkspaceDir(entry);
      removed++;
      this.log.info('retention.workspace_removed', { run_id: entry.runId, path: entry.path });
    }
    return removed;
  }

  private stale(entry: WorkspaceEntry, cutoff: number): boolean {
    const run = this.store.runs.getById(entry.runId);
    if (run === undefined) {
      return entry.mtime.getTime() < cutoff;
    }
    if ((ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
      return false;
    }
    const finished = run.finished_at === null ? entry.mtime.getTime() : Date.parse(run.finished_at);
    return finished < cutoff;
  }
}
