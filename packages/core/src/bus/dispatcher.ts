import type { Clock } from '../clock.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/store.js';
import type { RunRecord } from '../store/types.js';
import { CRON_TICK, type CompiledConfig } from './matcher.js';

export interface DispatcherOptions {
  store: Store;
  clock: Clock;
  log: Logger;
  /** Events read per transaction. */
  batchSize?: number;
  /** Events deeper than this in a causal chain are dropped (runaway loop guard). */
  maxDepth?: number;
}

export interface DispatchResult {
  scanned: number;
  queued: RunRecord[];
}

export type QueuedListener = (runs: readonly RunRecord[]) => void;

const EMPTY_CONFIG: CompiledConfig = { tasks: [], byName: new Map() };

/**
 * Turns events past the `dispatch` cursor into `queued` runs. One `BEGIN IMMEDIATE`
 * transaction per batch: read, match, insert runs, advance cursor. A crash before commit
 * replays the batch; `UNIQUE(task, event_id)` makes the replay a no-op.
 */
export class Dispatcher {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly batchSize: number;
  private readonly maxDepth: number;
  private config: CompiledConfig = EMPTY_CONFIG;
  private readonly listeners = new Set<QueuedListener>();
  private wakePending = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: DispatcherOptions) {
    this.store = opts.store;
    this.clock = opts.clock;
    this.log = opts.log;
    this.batchSize = opts.batchSize ?? 100;
    this.maxDepth = opts.maxDepth ?? 32;
  }

  setConfig(config: CompiledConfig): void {
    this.config = config;
  }

  /** Executor hand-off: called once per batch with the runs it created. */
  onQueued(listener: QueuedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispatchOnce(): DispatchResult {
    const result = this.store.transaction((): DispatchResult => {
      const cursor = this.store.cursors.get('dispatch');
      const events = this.store.events.listAfter(cursor, this.batchSize);
      const last = events[events.length - 1];
      if (last === undefined) {
        return { scanned: 0, queued: [] };
      }
      const queued: RunRecord[] = [];
      for (const event of events) {
        if (event.depth > this.maxDepth) {
          this.log.warn('event.depth_exceeded', {
            event_id: event.id,
            event_type: event.type,
            depth: event.depth,
            correlation_id: event.correlation_id,
          });
          continue;
        }
        for (const task of this.config.tasks) {
          if (!task.matches(event, this.log)) {
            continue;
          }
          if (
            event.type === CRON_TICK &&
            task.overlapSkip &&
            this.store.runs.hasActive(task.name)
          ) {
            this.log.info('cron.skipped_overlap', { task: task.name, event_id: event.id });
            continue;
          }
          const now = this.clock.now();
          const run: RunRecord = {
            id: newId('run', now),
            task: task.name,
            event_id: event.id,
            correlation_id: event.correlation_id,
            status: 'queued',
            attempt: 0,
            created_at: now.toISOString(),
            started_at: null,
            finished_at: null,
            result: null,
            error: null,
          };
          if (!this.store.runs.insertQueued(run)) {
            continue; // replay of an already dispatched event
          }
          queued.push(run);
          this.log.info('run.queued', {
            run_id: run.id,
            task: run.task,
            event_id: event.id,
            event_type: event.type,
            correlation_id: run.correlation_id,
          });
        }
      }
      this.store.cursors.set('dispatch', last.seq);
      return { scanned: events.length, queued };
    });
    if (result.queued.length > 0) {
      for (const listener of this.listeners) {
        listener(result.queued);
      }
    }
    return result;
  }

  /** Dispatches until the backlog is empty. */
  drain(): RunRecord[] {
    const queued: RunRecord[] = [];
    for (;;) {
      const r = this.dispatchOnce();
      queued.push(...r.queued);
      if (r.scanned < this.batchSize) {
        return queued;
      }
    }
  }

  /** Schedules a drain on the next macrotask; many wakes coalesce into one drain. */
  wake(): void {
    if (this.wakePending) {
      return;
    }
    this.wakePending = true;
    setImmediate(() => {
      this.wakePending = false;
      if (!this.stopped) {
        this.safeDrain();
      }
    });
  }

  /** Periodic drain as a safety net for a lost wake. */
  start(intervalMs = 1000): void {
    this.stop();
    this.stopped = false;
    this.timer = setInterval(() => {
      this.safeDrain();
    }, intervalMs);
  }

  /** Also cancels a pending wake, so nothing touches the store after it is closed. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private safeDrain(): void {
    try {
      this.drain();
    } catch (err) {
      this.log.error('dispatch.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
