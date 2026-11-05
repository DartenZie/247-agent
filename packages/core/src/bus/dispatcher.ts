import type { Clock } from '../clock.js';
import { errorMessage } from '../errors.js';
import { compileTypePattern, isTypePattern, type TypeMatcher } from '../expr/glob.js';
import { compileFilter, type Filter } from '../expr/jmespath.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
import type { Store } from '../store/store.js';
import type { EventRecord, NewEvent, RunRecord } from '../store/types.js';
import type { WaitRecord } from '../store/waits.js';
import type { EventExplanation, SkipReason, TaskMatch } from './explain.js';
import { CRON_TICK, LOOP_DETECTED, type CompiledConfig, type CompiledTask } from './matcher.js';
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

/** The last drain, for `GET /v1/health`: `ok` until a drain throws, again after one succeeds. */
export interface DispatcherHealth {
  ok: boolean;
  /** The error of the last drain when it failed. */
  error: string | null;
  /** When drains started failing; `null` while they succeed. */
  failing_since: string | null;
}

const EMPTY_CONFIG: CompiledConfig = { tasks: [], byName: new Map() };

interface CompiledWait {
  readonly wait: WaitRecord;
  readonly type: TypeMatcher;
  readonly filter: Filter | undefined;
}

/**
 * The pending waits that compile, indexed for matching. Built from `store.waits` only when
 * its `revision` moves, so a batch neither re-reads nor recompiles waits that did not change,
 * and an event is checked only against waits for its exact type and the wildcard ones.
 */
interface WaitIndex {
  readonly revision: number;
  /** In `created_at` order. */
  readonly all: readonly CompiledWait[];
  readonly byType: ReadonlyMap<string, readonly CompiledWait[]>;
  readonly patterns: readonly CompiledWait[];
  /** Those with an `expires_at`, earliest first. */
  readonly byExpiry: readonly CompiledWait[];
  /** Waits whose type or filter does not compile, with the error. */
  readonly invalid: readonly { wait: WaitRecord; error: string }[];
  /** Whether `wait.invalid` was logged for `invalid`. */
  logged: boolean;
}

const NO_WAITS: readonly CompiledWait[] = [];

/** Whether the wait's deadline had passed when the event was stored. */
function expiredBy(w: CompiledWait, event: EventRecord): boolean {
  return w.wait.expires_at !== null && w.wait.expires_at <= event.ts;
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
  /** Chains `loop.detected` was committed for lately; the dedup key is the real guard. */
  private readonly reported = new Set<string>();
  /** Chains reported in the batch in flight, merged into `reported` once it commits. */
  private batchReported = new Set<string>();
  private config: CompiledConfig = EMPTY_CONFIG;
  private readonly listeners = new Set<QueuedListener>();
  private wakePending = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private lastHealth: DispatcherHealth = { ok: true, error: null, failing_since: null };
  private waitIndex: WaitIndex | undefined;
  private typeCache = new Map<string, TypeMatcher>();
  private filterCache = new Map<string, Filter>();

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

  /** Compiles a wait's type and filter, reusing the matchers of the previous index. */
  private compileWait(
    wait: WaitRecord,
    types = new Map<string, TypeMatcher>(),
    filters = new Map<string, Filter>(),
  ): CompiledWait {
    const type =
      types.get(wait.type) ?? this.typeCache.get(wait.type) ?? compileTypePattern(wait.type);
    types.set(wait.type, type);
    let filter: Filter | undefined;
    if (wait.filter !== null) {
      filter =
        filters.get(wait.filter) ?? this.filterCache.get(wait.filter) ?? compileFilter(wait.filter);
      filters.set(wait.filter, filter);
    }
    return { wait, type, filter };
  }

  /** The pending waits, compiled and indexed; rebuilt only when a wait changed. Logs nothing. */
  private pendingWaits(): WaitIndex {
    const revision = this.store.waits.revision;
    if (this.waitIndex?.revision === revision) {
      return this.waitIndex;
    }
    const types = new Map<string, TypeMatcher>();
    const filters = new Map<string, Filter>();
    const all: CompiledWait[] = [];
    const byType = new Map<string, CompiledWait[]>();
    const patterns: CompiledWait[] = [];
    const invalid: { wait: WaitRecord; error: string }[] = [];
    for (const wait of this.store.waits.listPending()) {
      let w: CompiledWait;
      try {
        w = this.compileWait(wait, types, filters);
      } catch (err) {
        invalid.push({ wait, error: errorMessage(err) });
        continue;
      }
      all.push(w);
      if (isTypePattern(wait.type)) {
        patterns.push(w);
      } else {
        const list = byType.get(wait.type);
        if (list === undefined) {
          byType.set(wait.type, [w]);
        } else {
          list.push(w);
        }
      }
    }
    const byExpiry = all
      .filter((w) => w.wait.expires_at !== null)
      .sort((a, b) => {
        const x = a.wait.expires_at ?? '';
        const y = b.wait.expires_at ?? '';
        return x < y ? -1 : x > y ? 1 : 0;
      });
    // Only matchers still in use are kept, so rendered filters do not pile up.
    this.typeCache = types;
    this.filterCache = filters;
    this.waitIndex = { revision, all, byType, patterns, byExpiry, invalid, logged: false };
    return this.waitIndex;
  }

  private logInvalidWaits(index: WaitIndex): void {
    if (index.logged) {
      return;
    }
    index.logged = true;
    for (const { wait, error } of index.invalid) {
      this.log.error('wait.invalid', { run_id: wait.run_id, task: wait.task, error });
    }
  }

  private waitMatches(w: CompiledWait, event: EventRecord, quiet = false): boolean {
    if (!w.type(event.type)) {
      return false;
    }
    if (w.filter === undefined) {
      return true;
    }
    try {
      return w.filter.evaluate(filterView(event));
    } catch (err) {
      if (quiet) {
        return false;
      }
      this.log.warn('wait.filter_error', {
        run_id: w.wait.run_id,
        task: w.wait.task,
        event_id: event.id,
        error: errorMessage(err),
      });
      return false;
    }
  }

  /**
   * `oa events show`, `oa emit`: per task of the active configuration, whether the event
   * matched its trigger and started a run, and why not. Pure: it logs nothing and writes
   * nothing. A skip is explained by what holds now (the pause, the limits, the active
   * runs), which is what held at dispatch unless something changed since.
   */
  explain(event: EventRecord): EventExplanation {
    const dispatched = event.seq <= this.store.cursors.get('dispatch');
    const runs = this.store.runs.listByEvent(event.id);
    const runOf = new Map(runs.map((r) => [r.task, r.id]));
    const tasks = this.config.tasks.map((task): TaskMatch => {
      const runId = runOf.get(task.name);
      if (runId !== undefined) {
        return { task: task.name, outcome: 'started', reason: null, detail: null, run_id: runId };
      }
      const verdict = task.explain(event);
      if (!verdict.matched) {
        const { reason, detail } = verdict;
        return { task: task.name, outcome: 'no_match', reason, detail, run_id: null };
      }
      const skip = this.skipReason(task, event, dispatched);
      if (skip === undefined) {
        return { task: task.name, outcome: 'pending', reason: null, detail: null, run_id: null };
      }
      return { task: task.name, outcome: 'skipped', ...skip, run_id: null };
    });
    const waitingRuns = dispatched
      ? []
      : this.pendingWaits()
          .all.filter((w) => !expiredBy(w, event) && this.waitMatches(w, event, true))
          .map((w) => w.wait.run_id);
    return { event_id: event.id, dispatched, runs, tasks, waiting_runs: waitingRuns };
  }

  /** Why a matching task starts no run for the event, in the order `dispatchOnce` checks. */
  private skipReason(
    task: CompiledTask,
    event: EventRecord,
    dispatched: boolean,
  ): { reason: SkipReason; detail: string | null } | undefined {
    if (event.depth > this.maxDepth) {
      return {
        reason: 'depth',
        detail: `depth ${String(event.depth)} is over limits.max_event_depth ${String(this.maxDepth)}`,
      };
    }
    const pausedAt = this.store.pauses.pausedAt(task.name);
    if (pausedAt !== undefined) {
      return { reason: 'paused', detail: `paused since ${pausedAt}` };
    }
    if (!dispatched) {
      return undefined;
    }
    if (event.type === CRON_TICK && task.overlapSkip) {
      return { reason: 'overlap', detail: 'a run of the task was active (overlap: skip)' };
    }
    const root =
      event.parent_id === null ? event.id : (this.store.events.rootOf(event.id) ?? event.id);
    if (this.store.events.countChainRuns(root) >= this.maxChainRuns) {
      return {
        reason: 'chain_runs',
        detail: `the chain of ${root} reached limits.max_runs_per_chain ${String(this.maxChainRuns)}`,
      };
    }
    return { reason: 'unknown', detail: null };
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
    let compiled: CompiledWait;
    try {
      compiled = this.compileWait(wait);
    } catch (err) {
      this.log.error('wait.invalid', {
        run_id: wait.run_id,
        task: wait.task,
        error: errorMessage(err),
      });
      return undefined;
    }
    const consumed = new Set(wait.consumed);
    // Events past the cursor are not dispatched yet; the dispatch loop will see them.
    const cursor = this.store.cursors.get('dispatch');
    let seq = afterSeq;
    while (seq < cursor) {
      const events = this.store.events.listOfType(wait.type, seq, cursor, this.batchSize);
      const last = events[events.length - 1];
      if (last === undefined) {
        break;
      }
      for (const event of events) {
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

  /**
   * Runs whose waits are past `expires_at` at `atIso`, re-queued. Called with the clock only
   * once the backlog is dispatched: an event stored before a deadline but dispatched after it
   * still ends the wait (#100).
   */
  private expireWaits(atIso: string): RunRecord[] {
    const out: RunRecord[] = [];
    for (const wait of this.store.waits.listExpired(atIso)) {
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
    if (this.reported.has(rootId) || this.batchReported.has(rootId)) {
      return;
    }
    this.batchReported.add(rootId);
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
    // A batch that rolls back takes its `loop.detected` with it; its replay publishes again.
    this.batchReported = new Set();
    const result = this.store.transaction((): DispatchResult => {
      const cursor = this.store.cursors.get('dispatch');
      const events = this.store.events.listAfter(cursor, this.batchSize);
      const last = events[events.length - 1];
      if (last === undefined) {
        return { scanned: 0, queued: this.expireWaits(this.clock.now().toISOString()) };
      }
      const queued: RunRecord[] = [];
      const waits = this.pendingWaits();
      this.logInvalidWaits(waits);
      // Waits this batch ended; the index stays as it was until the next batch rebuilds it.
      const ended = new Set<string>();
      let nextExpiry = 0;
      const paused = new Set(this.store.pauses.list().map((p) => p.task));
      // Runs per chain root, read once per batch and counted up as runs are inserted.
      const chainRuns = new Map<string, number>();
      for (const event of events) {
        // Ending a wait continues a run already in the chain; only starting new runs is a
        // hop the depth guard limits. So a too-deep event still resumes its waiter (an
        // `llm.batch.ended` one hop past the limit must not strand a billed batch), and
        // whatever the resumed run emits is deeper still and dropped here.
        let consumed = false;
        // The deadline passed before the event was stored: it is too late for these waits.
        // `byExpiry` is sorted, so the waits left past `nextExpiry` expire after this event.
        for (; nextExpiry < waits.byExpiry.length; nextExpiry++) {
          const w = waits.byExpiry[nextExpiry];
          if (w === undefined || !expiredBy(w, event)) {
            break;
          }
          if (ended.has(w.wait.run_id)) {
            continue;
          }
          ended.add(w.wait.run_id);
          const run = this.endWait(w.wait, 'timeout', undefined);
          if (run !== undefined) {
            queued.push(run);
          }
        }
        for (const candidates of [waits.byType.get(event.type) ?? NO_WAITS, waits.patterns]) {
          for (const w of candidates) {
            if (ended.has(w.wait.run_id) || !this.waitMatches(w, event)) {
              continue;
            }
            consumed = true;
            ended.add(w.wait.run_id);
            const run = this.endWait(w.wait, 'matched', event);
            if (run !== undefined) {
              queued.push(run);
            }
          }
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
          consumed = true;
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
        if (!consumed) {
          // Info, not debug: a mistyped event type nobody consumes must leave a trace.
          this.log.info('event.unconsumed', {
            event_id: event.id,
            event_type: event.type,
            source: event.source,
            correlation_id: event.correlation_id,
          });
        }
      }
      this.store.cursors.set('dispatch', last.seq);
      if (events.length < this.batchSize) {
        // Caught up: no event stored before now is left that could still end a wait.
        queued.push(...this.expireWaits(this.clock.now().toISOString()));
      }
      return { scanned: events.length, queued };
    });
    if (this.reported.size + this.batchReported.size > 1000) {
      this.reported.clear();
    }
    this.batchReported.forEach((root) => this.reported.add(root));
    this.handOff(result.queued);
    return result;
  }

  /**
   * Dispatches until the backlog is empty, in one go: start-up recovery and `manual.run`,
   * which must see their runs queued on return. A woken drain yields between batches.
   */
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

  /**
   * Schedules a drain on the next macrotask; many wakes coalesce into one drain. The drain
   * dispatches one batch per macrotask, so API requests, cron ticks and finished runs are
   * served between the batches of a long backlog.
   */
  wake(): void {
    if (this.wakePending) {
      return;
    }
    this.wakePending = true;
    setImmediate(() => {
      this.wakePending = false;
      if (!this.stopped) {
        this.drainStep();
      }
    });
  }

  /** Periodic drain as a safety net for a lost wake. */
  start(intervalMs = 1000): void {
    this.stop();
    this.stopped = false;
    this.timer = setInterval(() => {
      this.drainStep();
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

  health(): DispatcherHealth {
    return { ...this.lastHealth };
  }

  /** One batch; a full one wakes the next. A batch that throws is logged, not rethrown. */
  private drainStep(): void {
    let full: boolean;
    try {
      full = this.dispatchOnce().scanned >= this.batchSize;
      if (!this.lastHealth.ok) {
        this.log.info('dispatch.recovered', { failing_since: this.lastHealth.failing_since });
      }
      this.lastHealth = { ok: true, error: null, failing_since: null };
    } catch (err) {
      const error = errorMessage(err);
      this.metrics.dispatchFailures.inc();
      this.log.error('dispatch.failed', { error });
      this.lastHealth = {
        ok: false,
        error,
        failing_since: this.lastHealth.failing_since ?? this.clock.now().toISOString(),
      };
      return; // the 1 s timer retries
    }
    if (full) {
      this.wake();
    }
  }
}
