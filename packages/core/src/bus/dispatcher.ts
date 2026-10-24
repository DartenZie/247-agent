import type { Clock } from '../clock.js';
import { compileTypePattern, type TypeMatcher } from '../expr/glob.js';
import { compileFilter, type Filter } from '../expr/jmespath.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
import type { Store } from '../store/store.js';
import type { EventRecord, NewEvent, RunRecord } from '../store/types.js';
import type { WaitRecord } from '../store/waits.js';
import { CRON_TICK, LOOP_DETECTED, type CompiledConfig } from './matcher.js';
import { publishEvent, type PublishResult } from './publish.js';

export interface DispatcherOptions {
  store: Store;
  clock: Clock;
  log: Logger;
  /** Events read per transaction. */
  batchSize?: number;
  /** Events deeper than this in a causal chain are dropped (runaway loop guard). */
  maxDepth?: number;
  /** Runs one causal chain may start; its later events start none (fan-out storm guard). */
  maxChainRuns?: number;
  metrics?: Metrics | undefined;
  /** Publishes `loop.detected`; the bus passes its own so the event is counted and wakes. */
  publish?: ((input: NewEvent) => PublishResult) | undefined;
}

/** Why the dispatcher dropped an event: the `reason` label and `loop.detected` payload. */
export type DropReason = 'depth' | 'chain_runs';

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
 * A paused task (`store.pauses`) matches nothing: its events start no run, and they are
 * not replayed when it is resumed.
 *
 * Also ends waits (docs/internal/actions.md): an event matching a `waiting` run's wait, or a wait
 * past its `expires_at`, marks the wait resolved and re-queues the run, which is handed to
 * the executor like any other queued run.
 */
export class Dispatcher {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly batchSize: number;
  private readonly metrics: Metrics;
  private maxDepth: number;
  private maxChainRuns: number;
  private readonly publish: (input: NewEvent) => PublishResult;
  /** Chains `loop.detected` was published for lately; the dedup key is the real guard. */
  private readonly reported = new Set<string>();
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
    this.maxChainRuns = opts.maxChainRuns ?? 1000;
    this.metrics = opts.metrics ?? new Metrics();
    this.publish =
      opts.publish ??
      ((input) => {
        const r = publishEvent(this.store, this.clock, this.log, input);
        if (r.status === 'inserted') {
          this.wake();
        }
        return r;
      });
  }

  setConfig(config: CompiledConfig): void {
    this.config = config;
  }

  /** Reload seam: `limits.max_event_depth` and `limits.max_runs_per_chain`. */
  configure(opts: { maxDepth?: number | undefined; maxChainRuns?: number | undefined }): void {
    this.maxDepth = opts.maxDepth ?? this.maxDepth;
    this.maxChainRuns = opts.maxChainRuns ?? this.maxChainRuns;
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
    this.metrics.waitsEnded.inc({ task: wait.task, outcome });
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
   * `runId` against events already dispatched since `afterSeq` (the run's trigger), skipping the
   * wait's `consumed` events. Returns
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
    const consumed = new Set(wait.consumed);
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
        if (!consumed.has(event.id) && this.waitMatches(compiled, event)) {
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

  /**
   * Counts and logs a dropped event, and publishes `loop.detected` for its chain. The
   * `loop:<root>` dedup key makes that once per chain; the event is a root of its own, so
   * a task that alerts on it is neither too deep nor over the chain's cap.
   */
  private drop(event: EventRecord, reason: DropReason, rootId: string): void {
    const limit = reason === 'depth' ? this.maxDepth : this.maxChainRuns;
    this.metrics.eventsDropped.inc({ reason });
    this.log.warn(reason === 'depth' ? 'event.depth_exceeded' : 'event.chain_runs_exceeded', {
      event_id: event.id,
      event_type: event.type,
      depth: event.depth,
      root_event_id: rootId,
      limit,
      correlation_id: event.correlation_id,
    });
    if (this.reported.has(rootId)) {
      return;
    }
    if (this.reported.size >= 1000) {
      this.reported.clear();
    }
    this.reported.add(rootId);
    const r = this.publish({
      type: LOOP_DETECTED,
      source: 'core',
      dedup_key: `loop:${rootId}`,
      payload: {
        reason,
        limit,
        root_event_id: rootId,
        correlation_id: event.correlation_id,
        event_id: event.id,
        event_type: event.type,
        depth: event.depth,
      },
    });
    if (r.status === 'inserted') {
      this.log.warn(LOOP_DETECTED, {
        reason,
        root_event_id: rootId,
        event_id: event.id,
        correlation_id: event.correlation_id,
      });
    }
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
      const paused = new Set(this.store.pauses.list().map((p) => p.task));
      // Runs per chain root, read once per batch and counted up as runs are inserted.
      const chainRuns = new Map<string, number>();
      for (const event of events) {
        // Ending a wait continues a run already in the chain; only starting new runs is a
        // hop the depth guard limits. So a too-deep event still resumes its waiter (an
        // `llm.batch.ended` one hop past the limit must not strand a billed batch), and
        // whatever the resumed run emits is deeper still and dropped here.
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
        const rootId = event.parent_id === null ? event.id : this.store.events.rootOf(event.id);
        const root = rootId ?? event.id;
        if (event.depth > this.maxDepth) {
          this.drop(event, 'depth', root);
          continue;
        }
        let capped = false;
        for (const task of this.config.tasks) {
          if (!task.matches(event, this.log)) {
            continue;
          }
          if (paused.has(task.name)) {
            this.log.info('task.skipped_paused', { task: task.name, event_id: event.id });
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
          const started = chainRuns.get(root) ?? this.store.events.countChainRuns(root);
          chainRuns.set(root, started);
          if (started >= this.maxChainRuns) {
            capped = true;
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
          chainRuns.set(root, started + 1);
          queued.push(run);
          this.metrics.runsQueued.inc({ task: task.name });
          this.log.info('run.queued', {
            run_id: run.id,
            task: run.task,
            event_id: event.id,
            event_type: event.type,
            correlation_id: run.correlation_id,
          });
        }
        if (capped) {
          this.drop(event, 'chain_runs', root);
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
