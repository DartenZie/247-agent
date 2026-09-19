import type { ActionContext, ActionRunners } from '../actions/types.js';
import type { EventBus } from '../bus/bus.js';
import { MANUAL_RUN, taskSource, type CompiledConfig, type CompiledTask } from '../bus/matcher.js';
import type { Clock } from '../clock.js';
import { parseDuration } from '../config/duration.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/store.js';
import type { EventRecord, JsonValue, RunRecord } from '../store/types.js';

export interface ExecutorOptions {
  store: Store;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** Read on every run start so a reload applies to runs not yet started. */
  config: () => CompiledConfig;
  runners: ActionRunners;
  /** Runs in flight across all tasks. */
  workers?: number;
  /** For tasks without `timeout`. */
  defaultTimeout?: string;
}

export interface RecoveryResult {
  /** Runs found `running` at startup and failed as interrupted. */
  interrupted: number;
  /** Runs found `queued` at startup and taken over. */
  resumed: number;
}

/** Why the executor aborted a run's signal; runners rethrow it so the executor can tell. */
export class RunTimeoutError extends Error {
  constructor(readonly timeout: string) {
    super(`timed out after ${timeout}`);
    this.name = 'RunTimeoutError';
  }
}

export class RunStoppedError extends Error {
  constructor() {
    super('daemon stopping');
    this.name = 'RunStoppedError';
  }
}

type Outcome = { ok: true; result: JsonValue } | { ok: false; error: string };

const INTERRUPTED = 'interrupted: the daemon restarted while the run was in progress';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The action context's `event` for a run (ARCHITECTURE §3, `manual`): a `manual.run`
 * event with `payload.event` presents that event's type and payload under the
 * `manual.run` event's own ids, so correlation and depth are unchanged.
 */
export function contextEvent(trigger: EventRecord): EventRecord {
  if (trigger.type !== MANUAL_RUN) {
    return trigger;
  }
  const p = trigger.payload;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    return trigger;
  }
  const inner = p.event;
  if (inner === null || inner === undefined || typeof inner !== 'object' || Array.isArray(inner)) {
    return trigger;
  }
  return {
    ...trigger,
    type: typeof inner.type === 'string' ? inner.type : trigger.type,
    payload: inner.payload ?? null,
  };
}

/**
 * Worker pool over queued runs (ARCHITECTURE §4, §10). The dispatcher hands runs over via
 * `bus.onQueued`; on `start()` the executor also adopts whatever is `queued` in the store
 * and fails whatever was left `running` by a previous process. Per-task `concurrency` and
 * the global `workers` cap are enforced here, never by the dispatcher. Every finished run
 * publishes `task.<name>.succeeded|failed` with `source: task:<name>` and the trigger event
 * as parent, so downstream tasks chain through events only.
 *
 * Retries, `emit` routing and `state_updates` are not applied yet.
 */
export class Executor {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly config: () => CompiledConfig;
  private readonly runners: ActionRunners;
  private readonly workers: number;
  private readonly defaultTimeout: string;

  private readonly pending: RunRecord[] = [];
  private readonly known = new Set<string>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly perTask = new Map<string, number>();
  private readonly idleWaiters: (() => void)[] = [];
  private unsubscribe: (() => void) | undefined;
  private stopping = false;

  constructor(opts: ExecutorOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.log = opts.log;
    this.config = opts.config;
    this.runners = opts.runners;
    this.workers = opts.workers ?? 4;
    this.defaultTimeout = opts.defaultTimeout ?? '15m';
    parseDuration(this.defaultTimeout); // fail fast on a bad default
  }

  /** Subscribes to the dispatcher, recovers store state, starts running. Idempotent. */
  start(): RecoveryResult {
    this.stopping = false;
    this.unsubscribe ??= this.bus.onQueued((runs) => {
      this.enqueue(runs);
    });
    let interrupted = 0;
    for (const run of this.store.runs.listByStatus('running', 1_000_000)) {
      if (this.inFlight.has(run.id)) {
        continue; // ours: start() after stop() in the same process
      }
      this.finish(run, { ok: false, error: INTERRUPTED }, this.log.child(runFields(run)));
      interrupted++;
    }
    const queued = this.store.runs.listByStatus('queued', 1_000_000);
    const resumed = this.enqueue(queued);
    this.log.info('executor.started', { workers: this.workers, interrupted, resumed });
    return { interrupted, resumed };
  }

  /** Takes runs from the dispatcher. Returns how many were new to the executor. */
  enqueue(runs: readonly RunRecord[]): number {
    let added = 0;
    for (const run of runs) {
      if (this.known.has(run.id)) {
        continue;
      }
      this.known.add(run.id);
      this.pending.push(run);
      added++;
    }
    this.pump();
    return added;
  }

  /**
   * Stops taking runs, aborts the ones in flight and waits for them to settle. Aborted runs
   * stay `running` in the store; the next `start()` fails them as interrupted, exactly as
   * after a crash. Runs still `queued` are left for the next start too.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const run of this.pending.splice(0)) {
      this.known.delete(run.id);
    }
    for (const controller of this.inFlight.values()) {
      controller.abort(new RunStoppedError());
    }
    await this.idle();
  }

  /** Resolves once nothing is pending or in flight. Mainly for tests. */
  idle(): Promise<void> {
    if (this.pending.length === 0 && this.inFlight.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stats(): { pending: number; in_flight: number } {
    return { pending: this.pending.length, in_flight: this.inFlight.size };
  }

  private pump(): void {
    if (this.stopping) {
      return;
    }
    const config = this.config();
    for (let i = 0; i < this.pending.length && this.inFlight.size < this.workers;) {
      const run = this.pending[i];
      if (run === undefined) {
        break;
      }
      const task = config.byName.get(run.task);
      const limit = task?.config.concurrency ?? 1;
      if ((this.perTask.get(run.task) ?? 0) >= limit) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      void this.execute(run, task);
    }
  }

  private async execute(run: RunRecord, task: CompiledTask | undefined): Promise<void> {
    const log = this.log.child(runFields(run));
    const controller = new AbortController();
    this.inFlight.set(run.id, controller);
    this.perTask.set(run.task, (this.perTask.get(run.task) ?? 0) + 1);
    try {
      const current: RunRecord = { ...run, attempt: run.attempt + 1, status: 'running' };
      this.store.runs.setStatus(run.id, 'running', {
        started_at: this.clock.now().toISOString(),
        attempt: current.attempt,
      });
      log.info('run.started', { attempt: current.attempt, event_id: run.event_id });
      const outcome = await this.perform(current, task, controller, log);
      if (outcome === 'stopped') {
        log.warn('run.abandoned', { attempt: current.attempt });
      } else {
        this.finish(current, outcome, log);
      }
    } catch (err) {
      // Bookkeeping failure (store, bus); the run itself already went through `perform`.
      log.error('run.bookkeeping_failed', { error: errorMessage(err) });
    } finally {
      this.inFlight.delete(run.id);
      this.known.delete(run.id);
      const n = (this.perTask.get(run.task) ?? 1) - 1;
      if (n <= 0) {
        this.perTask.delete(run.task);
      } else {
        this.perTask.set(run.task, n);
      }
      this.pump();
      if (this.pending.length === 0 && this.inFlight.size === 0) {
        for (const resolve of this.idleWaiters.splice(0)) {
          resolve();
        }
      }
    }
  }

  /** Never throws: any failure is an outcome. `stopped` = aborted by `stop()`. */
  private async perform(
    run: RunRecord,
    task: CompiledTask | undefined,
    controller: AbortController,
    log: Logger,
  ): Promise<Outcome | 'stopped'> {
    if (task === undefined) {
      return { ok: false, error: `task "${run.task}" is no longer configured` };
    }
    const kind = task.config.action.kind;
    const runner = this.runners[kind];
    if (runner === undefined) {
      return { ok: false, error: `action kind "${kind}" has no runner` };
    }
    const trigger = this.store.events.getById(run.event_id);
    if (trigger === undefined) {
      return { ok: false, error: `trigger event "${run.event_id}" not found` };
    }
    const timeout = task.config.timeout ?? this.defaultTimeout;
    const timer = setTimeout(() => {
      controller.abort(new RunTimeoutError(timeout));
    }, parseDuration(timeout));
    const ctx: ActionContext = {
      run,
      event: contextEvent(trigger),
      task: task.config,
      signal: controller.signal,
      log,
    };
    try {
      const result = await runner(task.config.action, ctx);
      return { ok: true, result };
    } catch (err) {
      if (controller.signal.reason instanceof RunStoppedError) {
        return 'stopped';
      }
      if (controller.signal.reason instanceof RunTimeoutError) {
        return { ok: false, error: controller.signal.reason.message };
      }
      return { ok: false, error: errorMessage(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persists the terminal status and publishes the lifecycle event. */
  private finish(run: RunRecord, outcome: Outcome, log: Logger): void {
    const finishedAt = this.clock.now().toISOString();
    const source = taskSource(run.task);
    if (outcome.ok) {
      this.store.runs.setStatus(run.id, 'succeeded', {
        finished_at: finishedAt,
        result: outcome.result,
      });
      log.info('run.succeeded');
      this.publish({
        type: `task.${run.task}.succeeded`,
        source,
        parent_id: run.event_id,
        payload: { run_id: run.id, task: run.task, result: outcome.result },
      });
    } else {
      this.store.runs.setStatus(run.id, 'failed', {
        finished_at: finishedAt,
        error: outcome.error,
      });
      log.error('run.failed', { error: outcome.error });
      this.publish({
        type: `task.${run.task}.failed`,
        source,
        parent_id: run.event_id,
        payload: { run_id: run.id, task: run.task, error: outcome.error, attempt: run.attempt },
      });
    }
  }

  private publish(event: Parameters<EventBus['publish']>[0]): void {
    try {
      this.bus.publish(event);
    } catch (err) {
      this.log.error('run.lifecycle_publish_failed', {
        event_type: event.type,
        error: errorMessage(err),
      });
    }
  }
}

function runFields(run: RunRecord): { run_id: string; task: string; correlation_id: string } {
  return { run_id: run.id, task: run.task, correlation_id: run.correlation_id };
}
