import { setTimeout as sleep } from 'node:timers/promises';

import {
  isRetryable,
  NonRetryableError,
  withScope,
  type ActionContext,
  type ActionRunners,
  type ConnectorClients,
  type ResumeInfo,
  type WaitSpec,
} from '../actions/types.js';
import type { SandboxConfig } from '../actions/sandbox.js';
import { eventView } from '../actions/wait.js';
import type { EventBus } from '../bus/bus.js';
import { MANUAL_RUN, taskSource, type CompiledConfig, type CompiledTask } from '../bus/matcher.js';
import type { Clock } from '../clock.js';
import { parseDuration } from '../config/duration.js';
import { Retry, type EmitRuleConfig, type RetryConfig } from '../config/schema.js';
import { isJmesTruthy } from '../expr/jmespath.js';
import {
  evaluateExpr,
  renderTemplate,
  renderText,
  renderValue,
  type TemplateScope,
} from '../expr/template.js';
import type { Logger } from '../log.js';
import { SecretError, staticSecrets, type SecretsBackend } from '../secrets/secrets.js';
import type { Store } from '../store/store.js';
import type { EventRecord, JsonValue, NewEvent, RunRecord } from '../store/types.js';

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
  /** For tasks without `retry`. */
  defaultRetry?: RetryConfig;
  /** For `shell` actions without `sandbox`. */
  defaultSandbox?: SandboxConfig;
  /** Resolves `${secrets.<name>}`; defaults to a backend with no secrets. */
  secrets?: SecretsBackend;
  /** Connector ops for `connector` actions and sequence steps. */
  connectors?: ConnectorClients;
  /** The `env` template scope. */
  env?: Record<string, string>;
}

export interface RecoveryResult {
  /** Runs found `running` at startup and failed as interrupted (no attempts left). */
  interrupted: number;
  /** Runs found `queued` or `running` at startup and taken over. */
  resumed: number;
  /** Runs found `waiting` at startup whose wait is still armed. */
  waiting: number;
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

/** The signal `ctx.suspend()` rejects with; runners let it propagate. */
export class RunSuspendedError extends Error {
  constructor() {
    super('run suspended');
    this.name = 'RunSuspendedError';
  }
}

type Outcome = { ok: true; result: JsonValue } | { ok: false; error: string; retryable: boolean };

const INTERRUPTED = 'interrupted: the daemon restarted while the run was in progress';
const NO_SECRETS = staticSecrets({});

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

/** Milliseconds to wait before attempt `attempt + 1`. */
export function backoffDelay(policy: RetryConfig, attempt: number): number {
  const base = parseDuration(policy.base);
  if (policy.backoff === 'fixed') {
    return base;
  }
  return Math.min(base * 2 ** Math.max(0, attempt - 1), parseDuration(policy.max));
}

/**
 * Renders a task's `emit` rules (ARCHITECTURE §5.7) into events to publish. Throws
 * `NonRetryableError` when a rule cannot be rendered.
 */
export function renderEmits(
  rules: readonly EmitRuleConfig[],
  scope: TemplateScope,
  source: string,
  parentId: string,
): NewEvent[] {
  const out: NewEvent[] = [];
  rules.forEach((rule, i) => {
    try {
      if (rule.when !== undefined && !isJmesTruthy(evaluateExpr(rule.when, scope))) {
        return;
      }
      let items: unknown[] = [undefined];
      if (rule.each !== undefined) {
        const rendered = renderTemplate(rule.each, scope);
        if (rendered === null) {
          return; // nothing to fan out
        }
        if (!Array.isArray(rendered)) {
          throw new Error(`each did not render to an array (got ${typeof rendered})`);
        }
        items = rendered;
      }
      for (const item of items) {
        const s: TemplateScope = item === undefined ? scope : { ...scope, item };
        out.push({
          type: rule.type,
          source,
          parent_id: parentId,
          dedup_key: rule.dedup_key === undefined ? undefined : renderText(rule.dedup_key, s),
          payload: rule.payload === undefined ? null : (renderValue(rule.payload, s) as JsonValue),
        });
      }
    } catch (err) {
      throw new NonRetryableError(`emit[${String(i)}] (${rule.type}): ${errorMessage(err)}`, {
        cause: err,
      });
    }
  });
  return out;
}

/** Renders `state_updates` into `(namespace, key, value)` triples. */
export function renderStateUpdates(
  updates: Readonly<Record<string, unknown>> | undefined,
  scope: TemplateScope,
): { namespace: string; key: string; value: JsonValue }[] {
  if (updates === undefined) {
    return [];
  }
  return Object.entries(updates).map(([path, template]) => {
    const dot = path.indexOf('.');
    try {
      return {
        namespace: path.slice(0, dot),
        key: path.slice(dot + 1),
        value: renderValue(template, scope) as JsonValue,
      };
    } catch (err) {
      throw new NonRetryableError(`state_updates.${path}: ${errorMessage(err)}`, { cause: err });
    }
  });
}

interface Slot {
  /** Aborted by `stop()`; attempts combine it with their own timeout signal. */
  readonly stop: AbortController;
}

/**
 * Worker pool over queued runs (ARCHITECTURE §4, §10). The dispatcher hands runs over via
 * `bus.onQueued`; on `start()` the executor also adopts whatever is `queued` in the store
 * and recovers whatever was left `running` or `waiting` by a previous process. Per-task
 * `concurrency` and the global `workers` cap are enforced here, never by the dispatcher.
 *
 * Per run: secrets named by the task's templates are resolved, the action runs with a
 * timeout per attempt, failures are retried per `retry` with backoff, and on success
 * `state_updates` are applied and `emit` events published in one transaction with the
 * `task.<name>.succeeded` event (`source: task:<name>`, the trigger event as parent).
 * `task.<name>.failed` fires after the last attempt only. A `wait` parks the run in
 * `waiting` (freeing its worker slot); the dispatcher re-queues it when the awaited event
 * arrives or the wait expires, and the runner is started again with `ctx.resume`.
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
  private readonly defaultSandbox: SandboxConfig | undefined;
  private readonly defaultRetry: RetryConfig;
  private readonly secrets: SecretsBackend;
  private readonly connectors: ConnectorClients | undefined;
  private readonly env: Record<string, string>;

  private readonly pending: RunRecord[] = [];
  private readonly known = new Set<string>();
  private readonly inFlight = new Map<string, Slot>();
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
    this.defaultSandbox = opts.defaultSandbox;
    this.defaultRetry = opts.defaultRetry ?? Retry.parse({});
    this.secrets = opts.secrets ?? NO_SECRETS;
    this.connectors = opts.connectors;
    this.env = opts.env ?? {};
    parseDuration(this.defaultTimeout); // fail fast on a bad default
  }

  /** Subscribes to the dispatcher, recovers store state, starts running. Idempotent. */
  start(): RecoveryResult {
    this.stopping = false;
    this.unsubscribe ??= this.bus.onQueued((runs) => {
      this.enqueue(runs);
    });
    let interrupted = 0;
    let resumed = 0;
    let waiting = 0;
    const config = this.config();
    for (const run of this.store.runs.listByStatus('running', 1_000_000)) {
      if (this.inFlight.has(run.id)) {
        continue; // ours: start() after stop() in the same process
      }
      const task = config.byName.get(run.task);
      const log = this.log.child(runFields(run));
      if (task !== undefined && run.attempt < this.retryFor(task).attempts) {
        log.warn('run.recovered', { attempt: run.attempt });
        resumed += this.enqueue([run]);
        continue;
      }
      this.finish(run, { ok: false, error: INTERRUPTED, retryable: false }, task, log);
      interrupted++;
    }
    for (const run of this.store.runs.listByStatus('waiting', 1_000_000)) {
      const wait = this.store.waits.get(run.id);
      const log = this.log.child(runFields(run));
      if (wait === undefined) {
        const task = config.byName.get(run.task);
        this.finish(
          run,
          { ok: false, error: 'waiting run has no wait record', retryable: false },
          task,
          log,
        );
        interrupted++;
      } else if (wait.outcome !== null) {
        this.store.runs.setStatus(run.id, 'queued');
        resumed += this.enqueue([{ ...run, status: 'queued' }]);
      } else {
        waiting++;
      }
    }
    resumed += this.enqueue(this.store.runs.listByStatus('queued', 1_000_000));
    this.log.info('executor.started', { workers: this.workers, interrupted, resumed, waiting });
    return { interrupted, resumed, waiting };
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
   * stay `running` in the store; the next `start()` retries or fails them, exactly as
   * after a crash. Runs still `queued` are left for the next start too.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const run of this.pending.splice(0)) {
      this.known.delete(run.id);
    }
    for (const slot of this.inFlight.values()) {
      slot.stop.abort(new RunStoppedError());
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

  private retryFor(task: CompiledTask | undefined): RetryConfig {
    return task?.config.retry ?? this.defaultRetry;
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
    const slot: Slot = { stop: new AbortController() };
    this.inFlight.set(run.id, slot);
    this.perTask.set(run.task, (this.perTask.get(run.task) ?? 0) + 1);
    let suspended = false;
    try {
      // A run re-queued by the dispatcher after its wait ended continues its attempt.
      const wait = this.store.waits.get(run.id);
      const resume = wait?.outcome === null || wait === undefined ? undefined : wait;
      const resuming = resume !== undefined && run.status === 'queued';
      let attempt = run.attempt + (resuming ? 0 : 1);
      const policy = this.retryFor(task);
      for (;;) {
        const current: RunRecord = { ...run, attempt, status: 'running' };
        this.store.runs.setStatus(run.id, 'running', {
          started_at: this.clock.now().toISOString(),
          attempt,
        });
        log.info(resuming ? 'run.resumed' : 'run.started', { attempt, event_id: run.event_id });
        const resumeInfo: ResumeInfo | undefined =
          resume === undefined
            ? undefined
            : {
                resume: resume.resume,
                outcome: resume.outcome ?? 'timeout',
                event:
                  resume.event_id === null ? undefined : this.store.events.getById(resume.event_id),
              };
        const performed = await this.perform(current, task, slot, resumeInfo, log);
        if (performed === 'stopped') {
          log.warn('run.abandoned', { attempt });
          return;
        }
        if (performed === 'suspended') {
          suspended = true;
          return;
        }
        const outcome = performed;
        if (outcome.ok || !outcome.retryable || attempt >= policy.attempts || this.stopping) {
          this.finish(current, outcome, task, log);
          return;
        }
        const delay = backoffDelay(policy, attempt);
        log.warn('run.retry', {
          attempt,
          attempts: policy.attempts,
          delay_ms: delay,
          error: outcome.error,
        });
        this.store.runs.setStatus(run.id, 'running', { error: outcome.error });
        try {
          await sleep(delay, undefined, { signal: slot.stop.signal });
        } catch {
          log.warn('run.abandoned', { attempt });
          return; // stopping: stays `running`, recovered on the next start
        }
        attempt++;
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
      if (suspended) {
        // The wait may have ended while we were still cleaning up; the dispatcher's hand-off
        // was then refused because the run was still known. Pick it up from the store.
        const fresh = this.store.runs.getById(run.id);
        if (fresh?.status === 'queued') {
          this.enqueue([fresh]);
        }
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
    slot: Slot,
    resume: ResumeInfo | undefined,
    log: Logger,
  ): Promise<Outcome | 'stopped' | 'suspended'> {
    if (task === undefined) {
      return fatal(`task "${run.task}" is no longer configured`);
    }
    const kind = task.config.action.kind;
    const runner = this.runners[kind];
    if (runner === undefined) {
      return fatal(`action kind "${kind}" has no runner`);
    }
    const trigger = this.store.events.getById(run.event_id);
    if (trigger === undefined) {
      return fatal(`trigger event "${run.event_id}" not found`);
    }
    let secrets: Record<string, string>;
    try {
      secrets = this.secrets.resolve(task.secretNames);
    } catch (err) {
      if (err instanceof SecretError) {
        return { ok: false, error: err.message, retryable: false };
      }
      return { ok: false, error: errorMessage(err), retryable: true };
    }
    const timeout = task.config.timeout ?? this.defaultTimeout;
    const attemptController = new AbortController();
    const timer = setTimeout(() => {
      attemptController.abort(new RunTimeoutError(timeout));
    }, parseDuration(timeout));
    const signal = AbortSignal.any([slot.stop.signal, attemptController.signal]);
    const event = contextEvent(trigger);
    const scope: TemplateScope = {
      event: eventView(event),
      state: this.store.state.snapshot(),
      secrets,
      env: this.env,
      run: runView(run),
    };
    const base: ActionContext = {
      run,
      event,
      task: task.config,
      signal,
      log,
      state: scope.state as ActionContext['state'],
      secrets,
      scope,
      render: () => null,
      renderText: () => '',
      connectors: this.connectors,
      sandbox: this.defaultSandbox,
      suspend: (spec, data) => this.suspend(run, trigger, spec, data, log),
      resume,
    };
    const ctx = withScope(base, {});
    try {
      const result = await runner(task.config.action, ctx);
      return { ok: true, result };
    } catch (err) {
      if (err instanceof RunSuspendedError) {
        return 'suspended';
      }
      if (slot.stop.signal.aborted) {
        return 'stopped';
      }
      if (attemptController.signal.aborted) {
        return {
          ok: false,
          error: (attemptController.signal.reason as Error).message,
          retryable: true,
        };
      }
      return { ok: false, error: errorMessage(err), retryable: isRetryable(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `ctx.suspend`: records the wait and parks the run. Events published since the run's
   * trigger are checked right away, so a reply that arrived while the asking step was still
   * running is not missed. Always rejects with `RunSuspendedError`.
   */
  private suspend(
    run: RunRecord,
    trigger: EventRecord,
    spec: WaitSpec,
    resume: JsonValue,
    log: Logger,
  ): Promise<never> {
    const now = this.clock.now();
    const expiresAt =
      spec.timeoutMs === undefined ? null : new Date(now.getTime() + spec.timeoutMs).toISOString();
    this.store.transaction(() => {
      this.store.waits.insert({
        run_id: run.id,
        task: run.task,
        type: spec.type,
        filter: spec.filter ?? null,
        expires_at: expiresAt,
        on_timeout: spec.on_timeout,
        resume,
        created_at: now.toISOString(),
      });
      this.store.runs.setStatus(run.id, 'waiting');
      const matched = this.bus.dispatcher.matchWaitAgainstBacklog(run.id, trigger.seq);
      log.info('run.waiting', {
        wait_type: spec.type,
        expires_at: expiresAt,
        matched_event_id: matched?.id ?? null,
      });
    });
    return Promise.reject(new RunSuspendedError());
  }

  /** Persists the terminal status, applies routing and publishes the lifecycle event. */
  private finish(
    run: RunRecord,
    outcome: Outcome,
    task: CompiledTask | undefined,
    log: Logger,
  ): void {
    const source = taskSource(run.task);
    let emitted: NewEvent[] = [];
    let updates: ReturnType<typeof renderStateUpdates> = [];
    let final = outcome;
    if (outcome.ok && task !== undefined) {
      try {
        const trigger = this.store.events.getById(run.event_id);
        const scope: TemplateScope = {
          event: trigger === undefined ? null : eventView(contextEvent(trigger)),
          result: outcome.result,
          state: this.store.state.snapshot(),
          env: this.env,
          run: runView(run),
        };
        emitted = renderEmits(task.config.emit ?? [], scope, source, run.event_id);
        updates = renderStateUpdates(task.config.state_updates, scope);
      } catch (err) {
        final = { ok: false, error: errorMessage(err), retryable: false };
      }
    }
    const finishedAt = this.clock.now().toISOString();
    this.store.transaction(() => {
      this.store.waits.delete(run.id);
      if (final.ok) {
        this.store.runs.setStatus(run.id, 'succeeded', {
          finished_at: finishedAt,
          result: final.result,
        });
        for (const u of updates) {
          this.store.state.put(u.namespace, u.key, u.value, finishedAt);
        }
        log.info('run.succeeded', { emitted: emitted.length, state_updates: updates.length });
        this.publish({
          type: `task.${run.task}.succeeded`,
          source,
          parent_id: run.event_id,
          payload: { run_id: run.id, task: run.task, result: final.result },
        });
        for (const e of emitted) {
          this.publish(e);
        }
      } else {
        this.store.runs.setStatus(run.id, 'failed', {
          finished_at: finishedAt,
          error: final.error,
        });
        log.error('run.failed', { error: final.error, attempt: run.attempt });
        this.publish({
          type: `task.${run.task}.failed`,
          source,
          parent_id: run.event_id,
          payload: { run_id: run.id, task: run.task, error: final.error, attempt: run.attempt },
        });
      }
    });
  }

  private publish(event: NewEvent): void {
    try {
      const r = this.bus.publish(event);
      if (r.status === 'duplicate') {
        this.log.debug('run.emit_duplicate', { event_type: event.type, dedup_key: r.dedup_key });
      }
    } catch (err) {
      this.log.error('run.lifecycle_publish_failed', {
        event_type: event.type,
        error: errorMessage(err),
      });
    }
  }
}

function fatal(error: string): Outcome {
  return { ok: false, error, retryable: false };
}

function runView(run: RunRecord): Record<string, JsonValue> {
  return {
    id: run.id,
    task: run.task,
    attempt: run.attempt,
    event_id: run.event_id,
    correlation_id: run.correlation_id,
  };
}

function runFields(run: RunRecord): { run_id: string; task: string; correlation_id: string } {
  return { run_id: run.id, task: run.task, correlation_id: run.correlation_id };
}
