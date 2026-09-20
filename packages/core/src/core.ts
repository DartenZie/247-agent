import { runConnector } from './actions/connector.js';
import { runLlm } from './actions/llm.js';
import { runSequence } from './actions/sequence.js';
import type { SandboxConfig } from './actions/sandbox.js';
import { runShell } from './actions/shell.js';
import type { ActionRunners, ConnectorClients } from './actions/types.js';
import { runWait } from './actions/wait.js';
import { createBus, type EventBus } from './bus/bus.js';
import { runTaskManually, type ManualInput } from './bus/manual.js';
import { compileConfig, type CompiledConfig } from './bus/matcher.js';
import { systemClock, type Clock } from './clock.js';
import type { ConnectorConfig } from './config/connector.js';
import { checkLlmTasks } from './config/crosscheck.js';
import { loadTasks, type TasksLoadResult } from './config/load.js';
import type { RetryConfig } from './config/schema.js';
import { Poller } from './connectors/poller.js';
import { ConnectorSupervisor } from './connectors/supervisor.js';
import { Executor } from './executor/executor.js';
import type { BudgetsConfig, LlmDefaultsConfig, ProviderConfigParsed } from './llm/config.js';
import type { PricingTable } from './llm/pricing.js';
import { LlmService } from './llm/service.js';
import type { ProviderFactories } from './llm/types.js';
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
  /** For `shell` actions without `sandbox`. */
  defaultSandbox?: SandboxConfig;
  /** Action runners by kind; defaults to the built-in ones. */
  runners?: ActionRunners;
  /** `${secrets.<name>}` backend; defaults to one with no secrets. */
  secrets?: SecretsBackend;
  /** The `env` template scope; defaults to none. */
  env?: Record<string, string>;
  /**
   * Connector manifests to supervise (needs `socketPath` for the children; built-in
   * pollers among them run in-process), or a ready-made `ConnectorClients` (tests).
   * Without either, `connector` actions fail.
   */
  connectors?: readonly ConnectorConfig[] | ConnectorClients;
  /** Passed to supervised connectors as `OA_CORE_SOCKET`. */
  socketPath?: string;
  /**
   * Model providers, prices and budgets from agent.yaml. Without it `llm` actions fail
   * with "no llm service is configured" and the tasks are not cross-checked against it.
   */
  llm?: CoreLlmOptions;
}

export interface CoreLlmOptions {
  providers: Readonly<Record<string, ProviderConfigParsed>>;
  pricing: PricingTable;
  defaults: LlmDefaultsConfig;
  budgets: BudgetsConfig;
  /** The agent.yaml directory (`system_file` paths). */
  configDir: string;
  /** Adapters by provider type; defaults to the built-in ones. */
  factories?: ProviderFactories;
}

export interface Core {
  readonly bus: EventBus;
  readonly store: Store;
  readonly scheduler: CronScheduler;
  readonly executor: Executor;
  /** The supervisor when the core spawns connectors itself. */
  readonly supervisor: ConnectorSupervisor | undefined;
  /** The built-in `poller` connectors, from manifests with `builtin: poller`. */
  readonly pollers: readonly Poller[];
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
  llm: runLlm,
  wait: runWait,
  sequence: runSequence,
};

/** Provider adapters by type. Stage 2/3 add `anthropic`, `openai` and `openrouter`. */
export const defaultProviderFactories: ProviderFactories = {};

function isClients(v: readonly ConnectorConfig[] | ConnectorClients): v is ConnectorClients {
  return !Array.isArray(v);
}

/** For a poller whose target has no supervisor (only reachable with a hand-built config). */
const noConnectors: ConnectorClients = {
  names: () => [],
  call: (connector) => Promise.reject(new Error(`unknown connector "${connector}"`)),
};

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
  let builtins: readonly ConnectorConfig[] = [];
  if (opts.connectors !== undefined) {
    if (isClients(opts.connectors)) {
      connectors = opts.connectors;
    } else {
      const processes = opts.connectors.filter((m) => m.builtin === undefined);
      builtins = opts.connectors.filter((m) => m.builtin !== undefined);
      if (processes.length > 0) {
        if (opts.socketPath === undefined) {
          throw new Error('socketPath is required to supervise connectors');
        }
        supervisor = new ConnectorSupervisor({
          manifests: processes,
          socketPath: opts.socketPath,
          secrets,
          log,
        });
        connectors = supervisor;
      }
    }
  }
  const pollers = builtins.map(
    (manifest) =>
      new Poller({
        manifest,
        clients: connectors ?? noConnectors,
        store,
        bus,
        clock,
        log,
        secrets,
        ...(opts.env === undefined ? {} : { env: opts.env }),
      }),
  );

  const llm =
    opts.llm === undefined
      ? undefined
      : new LlmService({
          store,
          bus,
          clock,
          log,
          secrets,
          env: opts.env,
          configDir: opts.llm.configDir,
          providers: opts.llm.providers,
          pricing: opts.llm.pricing,
          defaults: opts.llm.defaults,
          budgets: opts.llm.budgets,
          factories: opts.llm.factories ?? defaultProviderFactories,
        });

  const executor = new Executor({
    store,
    bus,
    clock,
    log,
    config: () => compiled,
    runners: opts.runners ?? defaultRunners,
    secrets,
    ...(llm === undefined ? {} : { llm }),
    ...(connectors === undefined ? {} : { connectors }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.workers === undefined ? {} : { workers: opts.workers }),
    ...(opts.defaultTimeout === undefined ? {} : { defaultTimeout: opts.defaultTimeout }),
    ...(opts.defaultRetry === undefined ? {} : { defaultRetry: opts.defaultRetry }),
    ...(opts.defaultSandbox === undefined ? {} : { defaultSandbox: opts.defaultSandbox }),
  });

  const load = (): TasksLoadResult => {
    let result = loadTasks(opts.tasksFiles);
    if (result.ok && result.config !== undefined && opts.llm !== undefined) {
      result = crossCheck(result, result.config.tasks, opts.llm);
    }
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
    pollers,
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
      for (const poller of pollers) {
        poller.start();
      }
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
      await Promise.all(pollers.map((p) => p.stop()));
      await supervisor?.stop();
      store.close();
    },
  };
}

/** Applies `checkLlmTasks` to a merged load; an issue fails the file its task came from. */
function crossCheck(
  result: TasksLoadResult,
  tasks: readonly CompiledConfig['tasks'][number]['config'][],
  llm: CoreLlmOptions,
): TasksLoadResult {
  const issues = checkLlmTasks(tasks, llm);
  if (issues.length === 0) {
    return result;
  }
  // Issue paths index the merged list; map each back to its file's own index.
  const files = result.files.map((f) => {
    if (!f.ok) {
      return f;
    }
    const own = issues.flatMap((i) => {
      const m = /^tasks\[(\d+)\]/.exec(i.path);
      const task = m === null ? undefined : tasks[Number(m[1])];
      const local = task === undefined ? -1 : f.config.tasks.indexOf(task);
      return local === -1
        ? []
        : [{ ...i, path: i.path.replace(/^tasks\[\d+\]/, `tasks[${String(local)}]`) }];
    });
    return own.length === 0 ? f : { ok: false as const, file: f.file, issues: own };
  });
  return { ok: false, files };
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
