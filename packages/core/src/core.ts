import { runConnector } from './actions/connector.js';
import { runSequence } from './actions/sequence.js';
import { runShell } from './actions/shell.js';
import type { ActionRunners, ConnectorClients } from './actions/types.js';
import { runWait } from './actions/wait.js';
import { createBus, type EventBus } from './bus/bus.js';
import { runTaskManually, type ManualInput } from './bus/manual.js';
import { compileConfig, type CompiledConfig } from './bus/matcher.js';
import { systemClock, type Clock } from './clock.js';
import type { ConnectorConfig } from './config/connector.js';
import { loadTasks, type TasksLoadResult } from './config/load.js';
import type { RetryConfig } from './config/schema.js';
import { ConnectorSupervisor } from './connectors/supervisor.js';
import { Executor } from './executor/executor.js';
import { createLogger, type Logger } from './log.js';
import { CronScheduler } from './scheduler/cron.js';
import { staticSecrets, type SecretsBackend } from './secrets/secrets.js';
import { openStore, type Store } from './store/store.js';
import type { RunRecord } from './store/types.js';

export interface CoreOptions {
  /** Tasks files and/or `tasks.d` directories, merged. */
  tasksFiles: string[];
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
  /** For tasks without `retry`. */
  defaultRetry?: RetryConfig;
  /** Action runners by kind; defaults to the built-in ones. */
  runners?: ActionRunners;
  /** `${secrets.<name>}` backend; defaults to one with no secrets. */
  secrets?: SecretsBackend;
  /** The `env` template scope; defaults to none. */
  env?: Record<string, string>;
  /**
   * Connector manifests to supervise (needs `socketPath` for the children), or a
   * ready-made `ConnectorClients` (tests). Without either, `connector` actions fail.
   */
  connectors?: readonly ConnectorConfig[] | ConnectorClients;
  /** Passed to supervised connectors as `OA_CORE_SOCKET`. */
  socketPath?: string;
}

export interface Core {
  readonly bus: EventBus;
  readonly store: Store;
  readonly scheduler: CronScheduler;
  readonly executor: Executor;
  /** The supervisor when the core spawns connectors itself. */
  readonly supervisor: ConnectorSupervisor | undefined;
  config(): CompiledConfig;
  /**
   * Loads config, opens the store, recovers runs, dispatches any backlog, arms cron jobs
   * and spawns connectors. Throws on invalid config.
   */
  start(): Promise<void>;
  /** Re-reads the tasks files. An invalid file is logged and the previous config stays active. */
  reload(): TasksLoadResult;
  /** `oa run <task>`: queue a run for any task, with an optional input event. */
  runTask(name: string, input?: ManualInput): { event_id: string; run: RunRecord };
  /** Aborts runs in flight (they are recovered on the next start), stops connectors, closes the store. */
  stop(): Promise<void>;
}

export class ConfigLoadError extends Error {
  constructor(readonly result: TasksLoadResult) {
    super(
      'invalid config:\n' +
        result.files
          .flatMap((f) =>
            f.ok
              ? []
              : f.issues.map(
                  (i) => `  ${f.file}: ${i.path === '' ? '' : i.path + ': '}${i.message}`,
                ),
          )
          .join('\n'),
    );
    this.name = 'ConfigLoadError';
  }
}

export const defaultRunners: ActionRunners = {
  shell: runShell,
  connector: runConnector,
  wait: runWait,
  sequence: runSequence,
};

function isClients(v: readonly ConnectorConfig[] | ConnectorClients): v is ConnectorClients {
  return !Array.isArray(v);
}

export function createCore(opts: CoreOptions): Core {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? createLogger();
  const secrets = opts.secrets ?? staticSecrets({});
  const store = openStore(opts.dbPath);
  const bus = createBus({
    store,
    clock,
    log,
    ...(opts.maxEventDepth === undefined ? {} : { maxDepth: opts.maxEventDepth }),
  });
  const scheduler = new CronScheduler({ bus, clock, log });
  let compiled: CompiledConfig = { tasks: [], byName: new Map() };

  let supervisor: ConnectorSupervisor | undefined;
  let connectors: ConnectorClients | undefined;
  if (opts.connectors !== undefined) {
    if (isClients(opts.connectors)) {
      connectors = opts.connectors;
    } else if (opts.connectors.length > 0) {
      if (opts.socketPath === undefined) {
        throw new Error('socketPath is required to supervise connectors');
      }
      supervisor = new ConnectorSupervisor({
        manifests: opts.connectors,
        socketPath: opts.socketPath,
        secrets,
        log,
      });
      connectors = supervisor;
    }
  }

  const executor = new Executor({
    store,
    bus,
    clock,
    log,
    config: () => compiled,
    runners: opts.runners ?? defaultRunners,
    secrets,
    ...(connectors === undefined ? {} : { connectors }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.workers === undefined ? {} : { workers: opts.workers }),
    ...(opts.defaultTimeout === undefined ? {} : { defaultTimeout: opts.defaultTimeout }),
    ...(opts.defaultRetry === undefined ? {} : { defaultRetry: opts.defaultRetry }),
  });

  const load = (): TasksLoadResult => {
    const result = loadTasks(opts.tasksFiles);
    if (result.ok && result.config !== undefined) {
      compiled = compileConfig(result.config);
      bus.dispatcher.setConfig(compiled);
      const names = new Set(connectors?.names() ?? []);
      for (const task of compiled.tasks) {
        for (const ref of connectorRefs(task.config.action)) {
          if (!names.has(ref)) {
            log.warn('core.unknown_connector', { task: task.name, connector: ref });
          }
        }
      }
    }
    return result;
  };

  return {
    bus,
    store,
    scheduler,
    executor,
    supervisor,
    config: () => compiled,
    start: async () => {
      const result = load();
      if (!result.ok) {
        throw new ConfigLoadError(result);
      }
      log.info('core.config_loaded', {
        files: result.files.map((f) => f.file).join(', '),
        tasks: compiled.tasks.length,
      });
      // Subscribe before draining so the backlog's runs reach the executor exactly once.
      const recovered = executor.start();
      const backlog = bus.dispatcher.drain();
      log.info('core.started', {
        backlog_runs: backlog.length,
        interrupted_runs: recovered.interrupted,
        resumed_runs: recovered.resumed,
        waiting_runs: recovered.waiting,
      });
      scheduler.start(compiled);
      bus.dispatcher.start(opts.dispatchIntervalMs ?? 1000);
      await supervisor?.start();
    },
    reload: () => {
      const result = load();
      if (result.ok) {
        scheduler.reload(compiled);
        log.info('core.config_reloaded', { tasks: compiled.tasks.length });
      } else {
        log.error('core.config_invalid', {
          files: result.files
            .filter((f) => !f.ok)
            .map((f) => f.file)
            .join(', '),
        });
      }
      return result;
    },
    runTask: (name, input) => runTaskManually(bus, store, compiled, name, input),
    stop: async () => {
      scheduler.stop();
      bus.dispatcher.stop();
      await executor.stop();
      await supervisor?.stop();
      store.close();
    },
  };
}

/** Connector names an action (or its sequence steps) calls. */
function connectorRefs(action: CompiledConfig['tasks'][number]['config']['action']): string[] {
  if (action.kind === 'connector') {
    return [action.connector];
  }
  if (action.kind === 'sequence') {
    return action.steps.flatMap((s) => (s.kind === 'connector' ? [s.connector] : []));
  }
  return [];
}
