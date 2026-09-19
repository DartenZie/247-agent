import { runShell } from './actions/shell.js';
import type { ActionRunners } from './actions/types.js';
import { createBus, type EventBus } from './bus/bus.js';
import { runTaskManually, type ManualInput } from './bus/manual.js';
import { compileConfig, type CompiledConfig } from './bus/matcher.js';
import { systemClock, type Clock } from './clock.js';
import { loadTasksFile, type LoadResult } from './config/load.js';
import { Executor } from './executor/executor.js';
import { createLogger, type Logger } from './log.js';
import { CronScheduler } from './scheduler/cron.js';
import { openStore, type Store } from './store/store.js';
import type { RunRecord } from './store/types.js';

export interface CoreOptions {
  tasksFile: string;
  dbPath: string;
  clock?: Clock;
  log?: Logger;
  /** Safety-net dispatch interval; every publish also wakes the dispatcher. */
  dispatchIntervalMs?: number;
  /** Events deeper than this in a causal chain are dropped. */
  maxEventDepth?: number;
  /** Runs in flight across all tasks. */
  workers?: number;
  /** For tasks without `timeout`. */
  defaultTimeout?: string;
  /** Action runners by kind; defaults to the built-in ones (`shell` for now). */
  runners?: ActionRunners;
}

export interface Core {
  readonly bus: EventBus;
  readonly store: Store;
  readonly scheduler: CronScheduler;
  readonly executor: Executor;
  config(): CompiledConfig;
  /**
   * Loads config, opens the store, recovers runs, dispatches any backlog, arms cron jobs.
   * Throws on invalid config.
   */
  start(): void;
  /** Re-reads the tasks file. An invalid file is logged and the previous config stays active. */
  reload(): LoadResult;
  /** `oa run <task>`: queue a run for any task, with an optional input event. */
  runTask(name: string, input?: ManualInput): { event_id: string; run: RunRecord };
  /** Aborts runs in flight (they are recovered on the next start) and closes the store. */
  stop(): Promise<void>;
}

export class ConfigLoadError extends Error {
  constructor(readonly result: Extract<LoadResult, { ok: false }>) {
    super(
      `invalid config ${result.file}:\n` +
        result.issues.map((i) => `  ${i.path === '' ? '' : i.path + ': '}${i.message}`).join('\n'),
    );
    this.name = 'ConfigLoadError';
  }
}

export const defaultRunners: ActionRunners = { shell: runShell };

export function createCore(opts: CoreOptions): Core {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? createLogger();
  const store = openStore(opts.dbPath);
  const bus = createBus({
    store,
    clock,
    log,
    ...(opts.maxEventDepth === undefined ? {} : { maxDepth: opts.maxEventDepth }),
  });
  const scheduler = new CronScheduler({ bus, clock, log });
  let compiled: CompiledConfig = { tasks: [], byName: new Map() };
  const executor = new Executor({
    store,
    bus,
    clock,
    log,
    config: () => compiled,
    runners: opts.runners ?? defaultRunners,
    ...(opts.workers === undefined ? {} : { workers: opts.workers }),
    ...(opts.defaultTimeout === undefined ? {} : { defaultTimeout: opts.defaultTimeout }),
  });

  const load = (): LoadResult => {
    const result = loadTasksFile(opts.tasksFile);
    if (result.ok) {
      compiled = compileConfig(result.config);
      bus.dispatcher.setConfig(compiled);
    }
    return result;
  };

  return {
    bus,
    store,
    scheduler,
    executor,
    config: () => compiled,
    start: () => {
      const result = load();
      if (!result.ok) {
        throw new ConfigLoadError(result);
      }
      log.info('core.config_loaded', { file: result.file, tasks: result.config.tasks.length });
      // Subscribe before draining so the backlog's runs reach the executor exactly once.
      const recovered = executor.start();
      const backlog = bus.dispatcher.drain();
      log.info('core.started', {
        backlog_runs: backlog.length,
        interrupted_runs: recovered.interrupted,
        resumed_runs: recovered.resumed,
      });
      scheduler.start(compiled);
      bus.dispatcher.start(opts.dispatchIntervalMs ?? 1000);
    },
    reload: () => {
      const result = load();
      if (result.ok) {
        scheduler.reload(compiled);
        log.info('core.config_reloaded', { file: result.file, tasks: result.config.tasks.length });
      } else {
        log.error('core.config_invalid', { file: result.file, issues: result.issues.length });
      }
      return result;
    },
    runTask: (name, input) => runTaskManually(bus, store, compiled, name, input),
    stop: async () => {
      scheduler.stop();
      bus.dispatcher.stop();
      await executor.stop();
      store.close();
    },
  };
}
