import type { Clock } from '../clock.js';
import { compileTypePattern, type TypeMatcher } from '../expr/glob.js';
import { compileFilter, type Filter } from '../expr/jmespath.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/store.js';
import type { EventRecord, RunRecord } from '../store/types.js';
import type { WaitRecord } from '../store/waits.js';
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

interface CompiledWait {
  readonly wait: WaitRecord;
  readonly type: TypeMatcher;
  readonly filter: Filter | undefined;
}

/** The event as wait filters see it: everything but the internal `seq`. */
function filterView(event: EventRecord): Omit<EventRecord, 'seq'> {
  const { seq: _seq, ...rest } = event;
  return rest;
}

/**
 * Turns events past the `dispatch` cursor into `queued` runs. One `BEGIN IMMEDIATE`
 * transaction per batch: read, match, insert runs, advance cursor. A crash before commit
 * replays the batch; `UNIQUE(task, event_id)` makes the replay a no-op.
 *
 * Also ends waits (ARCHITECTURE §5.6): an event matching a `waiting` run's wait, or a wait
 * past its `expires_at`, marks the wait resolved and re-queues the run, which is handed to
 * the executor like any other queued run.
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

  private compileWaits(): CompiledWait[] {
    const out: CompiledWait[] = [];
    for (const wait of this.store.waits.listPending()) {
      try {
        out.push({
          wait,
          type: compileTypePattern(wait.type),
          filter: wait.filter === null ? undefined : compileFilter(wait.filter),
        });
      } catch (err) {
        this.log.error('wait.invalid', {
          run_id: wait.run_id,
          task: wait.task,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  private waitMatches(w: CompiledWait, event: EventRecord): boolean {
    if (!w.type(event.type)) {
      return false;
    }
    if (w.filter === undefined) {
      return true;
    }
    try {
      return w.filter.evaluate(filterView(event));
    } catch (err) {
      this.log.warn('wait.filter_error', {
        run_id: w.wait.run_id,
        task: w.wait.task,
        event_id: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Ends a wait: marks it resolved, re-queues the run and returns the run for hand-off. */
  private endWait(
    wait: WaitRecord,
    outcome: 'matched' | 'timeout',
    event: EventRecord | undefined,
  ): RunRecord | undefined {
    if (!this.store.waits.resolve(wait.run_id, outcome, event?.id ?? null)) {
      return undefined;
    }
    this.store.runs.setStatus(wait.run_id, 'queued');
    const run = this.store.runs.getById(wait.run_id);
    this.log.info(outcome === 'matched' ? 'wait.matched' : 'wait.timeout', {
      run_id: wait.run_id,
      task: wait.task,
      wait_type: wait.type,
      event_id: event?.id ?? null,
      correlation_id: run?.correlation_id ?? null,
    });
    return run;
  }

  /**
   * Executor seam, called inside its suspend transaction: checks the wait just recorded for
   * `runId` against events already dispatched since `afterSeq` (the run's trigger). Returns
   * the matching event, if any; the run is then re-queued on the spot.
   */
  matchWaitAgainstBacklog(runId: string, afterSeq: number): EventRecord | undefined {
    const wait = this.store.waits.get(runId);
    if (wait?.outcome !== null) {
      return undefined;
    }
    const [compiled] = this.compileWaits().filter((w) => w.wait.run_id === runId);
    if (compiled === undefined) {
      return undefined;
    }
    const cursor = this.store.cursors.get('dispatch');
    let seq = afterSeq;
    while (seq < cursor) {
      const events = this.store.events.listAfter(seq, this.batchSize);
      const last = events[events.length - 1];
      if (last === undefined) {
        break;
      }
      for (const event of events) {
        if (event.seq > cursor) {
          break; // not dispatched yet; the dispatch loop will see it
        }
        if (event.depth <= this.maxDepth && this.waitMatches(compiled, event)) {
          const run = this.endWait(wait, 'matched', event);
          if (run !== undefined) {
            this.handOff([run]);
          }
          return event;
        }
      }
      seq = last.seq;
    }
    return undefined;
  }

  /** Runs whose waits are past `expires_at`, re-queued. */
  private expireWaits(): RunRecord[] {
    const out: RunRecord[] = [];
    for (const wait of this.store.waits.listExpired(this.clock.now().toISOString())) {
      const run = this.endWait(wait, 'timeout', undefined);
      if (run !== undefined) {
        out.push(run);
      }
    }
    return out;
  }

  private handOff(runs: readonly RunRecord[]): void {
    if (runs.length === 0) {
      return;
    }
    for (const listener of this.listeners) {
      listener(runs);
    }
  }

  dispatchOnce(): DispatchResult {
    const result = this.store.transaction((): DispatchResult => {
      const queued: RunRecord[] = this.expireWaits();
      const cursor = this.store.cursors.get('dispatch');
      const events = this.store.events.listAfter(cursor, this.batchSize);
      const last = events[events.length - 1];
      if (last === undefined) {
        return { scanned: 0, queued };
      }
      let waits = this.compileWaits();
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
        if (waits.length > 0) {
          const still: CompiledWait[] = [];
          for (const w of waits) {
            if (!this.waitMatches(w, event)) {
              still.push(w);
              continue;
            }
            const run = this.endWait(w.wait, 'matched', event);
            if (run !== undefined) {
              queued.push(run);
            }
          }
          waits = still;
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
    this.handOff(result.queued);
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
