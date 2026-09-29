import { runAgent } from './actions/agent.js';
import type { AgentDefaultsConfig } from './actions/agent-config.js';
import { runConnector } from './actions/connector.js';
import { runDecide } from './actions/decide.js';
import { runLlm } from './actions/llm.js';
import { runSequence } from './actions/sequence.js';
import type { SandboxConfig, SandboxHost } from './actions/sandbox.js';
import { runShell } from './actions/shell.js';
import type { ActionRunners, AgentClients, ConnectorClients } from './actions/types.js';
import { runWait } from './actions/wait.js';
import { createBus, type EventBus } from './bus/bus.js';
import { runTaskManually, type ManualInput } from './bus/manual.js';
import { compileConfig, type CompiledConfig } from './bus/matcher.js';
import { systemClock, type Clock } from './clock.js';
import type { ConnectorConfig } from './config/connector.js';
import {
  checkAgentTools,
  checkLlmTasks,
  checkSandboxes,
  type SandboxCheckContext,
} from './config/crosscheck.js';
import { loadTasks, type ConfigIssue, type TasksLoadResult } from './config/load.js';
import type { RetentionPolicy } from './config/retention.js';
import type { RetryConfig } from './config/schema.js';
import { Poller } from './connectors/poller.js';
import { ConnectorSupervisor, manifestKey, type ApplyResult } from './connectors/supervisor.js';
import { Executor } from './executor/executor.js';
import type {
  BudgetsConfig,
  DecideDefaultsConfig,
  LlmDefaultsConfig,
  ProviderConfigParsed,
} from './llm/config.js';
import type { PricingTable } from './llm/pricing.js';
import { startOfUtcDay } from './llm/pricing.js';
import { anthropicProvider } from './llm/anthropic.js';
import { openaiProvider } from './llm/openai.js';
import { openrouterProvider } from './llm/openrouter.js';
import { LlmService } from './llm/service.js';
import type { ProviderFactories } from './llm/types.js';
import { createLogger, type Logger } from './log.js';
import { Metrics } from './metrics.js';
import { RetentionJob } from './retention.js';
import { CronScheduler } from './scheduler/cron.js';
import { staticSecrets, type SecretsBackend } from './secrets/secrets.js';
import { openStore, type Store } from './store/store.js';
import type { RunRecord } from './store/types.js';
import { VERSION } from './version.js';

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
  /** What every sandbox (shell or agent program) hides and shows on this host; fixed for the process. */
  sandboxHost?: SandboxHost;
  /** The agent.yaml the settings came from, named in issues about it; defaults to none. */
  configFile?: string;
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
   * `defaults.agent` and the workspace root for `agent` actions on the supervisor's acp
   * connectors, or a ready-made `AgentClients` (tests). Without either, `agent` actions
   * fail.
   */
  agents?: { defaults: AgentDefaultsConfig; workDir: string } | AgentClients;
  /**
   * Model providers, prices and budgets from agent.yaml. Without it `llm` and `decide`
   * actions fail with "no llm service is configured" and the tasks are not cross-checked
   * against it.
   */
  llm?: CoreLlmOptions;
  /** `retention:` from agent.yaml; without it nothing is ever deleted. */
  retention?: RetentionPolicy;
  /** Shared with the API server for `GET /metrics`; defaults to a fresh registry. */
  metrics?: Metrics;
}

export interface CoreLlmOptions {
  providers: Readonly<Record<string, ProviderConfigParsed>>;
  pricing: PricingTable;
  defaults: LlmDefaultsConfig;
  /** `defaults.decide`; the built-in defaults when omitted. */
  decideDefaults?: DecideDefaultsConfig | undefined;
  budgets: BudgetsConfig;
  /** The agent.yaml directory (`system_file` paths). */
  configDir: string;
  /** Adapters by provider type; defaults to the built-in ones. */
  factories?: ProviderFactories;
}

/**
 * What a reload may change (ARCHITECTURE §4, §12): everything from agent.yaml except the
 * database, the socket and the secrets backend. Fields left out keep their current value.
 */
export interface CoreReloadOptions {
  tasksFiles?: string[] | undefined;
  /** Manifests to supervise from now on (ignored when the core was given ready-made clients). */
  connectors?: readonly ConnectorConfig[] | undefined;
  agents?: { defaults: AgentDefaultsConfig; workDir: string } | undefined;
  llm?: CoreLlmOptions | undefined;
  workers?: number | undefined;
  defaultTimeout?: string | undefined;
  defaultRetry?: RetryConfig | undefined;
  defaultSandbox?: SandboxConfig | undefined;
  maxEventDepth?: number | undefined;
  retention?: RetentionPolicy | undefined;
}

export interface ReloadResult extends TasksLoadResult {
  /** What happened to the supervised connectors, when the reload changed them. */
  connectors?: ApplyResult | undefined;
}

export interface Core {
  readonly bus: EventBus;
  readonly store: Store;
  readonly scheduler: CronScheduler;
  readonly executor: Executor;
  readonly metrics: Metrics;
  /** The supervisor when the core spawns connectors itself. */
  readonly supervisor: ConnectorSupervisor | undefined;
  /** The built-in `poller` connectors, from manifests with `builtin: poller`. */
  readonly pollers: readonly Poller[];
  /** The retention pass, when a policy was given. */
  readonly retention: RetentionJob | undefined;
  config(): CompiledConfig;
  /**
   * Loads config, opens the store, recovers runs, dispatches any backlog, arms cron jobs
   * and spawns connectors. Throws on invalid config.
   */
  start(): Promise<void>;
  /**
   * Re-reads the tasks files and applies `next` (new agent.yaml settings). All or nothing:
   * an invalid tasks file is logged, nothing changes and the previous config stays active.
   * Runs in flight finish under the settings they started with.
   */
  reload(next?: CoreReloadOptions): Promise<ReloadResult>;
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
  decide: runDecide,
  agent: runAgent,
  wait: runWait,
  sequence: runSequence,
};

/** Provider adapters by type. `openai` and `openrouter` come with stage 3. */
export const defaultProviderFactories: ProviderFactories = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  openrouter: openrouterProvider,
};

function isClients(v: readonly ConnectorConfig[] | ConnectorClients): v is ConnectorClients {
  return !Array.isArray(v);
}

function isAgentClients(v: NonNullable<CoreOptions['agents']>): v is AgentClients {
  return 'open' in v;
}

/** For a poller whose target has no supervisor (only reachable with a hand-built config). */
const noConnectors: ConnectorClients = {
  names: () => [],
  call: (connector) => Promise.reject(new Error(`unknown connector "${connector}"`)),
};

export function createCore(opts: CoreOptions): Core {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? createLogger();
  const metrics = opts.metrics ?? new Metrics();
  const secrets = opts.secrets ?? staticSecrets({});
  const store = openStore(opts.dbPath);
  const bus = createBus({
    store,
    clock,
    log,
    metrics,
    ...(opts.maxEventDepth === undefined ? {} : { maxDepth: opts.maxEventDepth }),
  });
  const scheduler = new CronScheduler({ bus, clock, log, metrics });
  let compiled: CompiledConfig = { tasks: [], byName: new Map() };
  let tasksFiles = opts.tasksFiles;
  let llmOptions = opts.llm;
  let defaultSandbox = opts.defaultSandbox;
  let startedAt: Date | undefined;

  let supervisor: ConnectorSupervisor | undefined;
  let connectors: ConnectorClients | undefined;
  let agents: AgentClients | undefined =
    opts.agents !== undefined && isAgentClients(opts.agents) ? opts.agents : undefined;
  let manifests: readonly ConnectorConfig[] = [];
  if (opts.connectors !== undefined) {
    if (isClients(opts.connectors)) {
      connectors = opts.connectors;
    } else {
      manifests = opts.connectors;
      const processes = manifests.filter((m) => m.builtin === undefined);
      if (opts.socketPath === undefined && processes.length > 0) {
        throw new Error('socketPath is required to supervise connectors');
      }
      if (opts.socketPath !== undefined) {
        supervisor = new ConnectorSupervisor({
          manifests: processes,
          socketPath: opts.socketPath,
          secrets,
          log,
          metrics,
          agents:
            opts.agents === undefined || isAgentClients(opts.agents) ? undefined : opts.agents,
          sandboxHost: opts.sandboxHost,
        });
        connectors = supervisor;
        agents ??= supervisor;
      }
    }
  }

  const makePoller = (manifest: ConnectorConfig): Poller =>
    new Poller({
      manifest,
      clients: connectors ?? noConnectors,
      store,
      bus,
      clock,
      log,
      secrets,
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });
  let pollers: { manifest: ConnectorConfig; poller: Poller }[] = manifests
    .filter((m) => m.builtin !== undefined)
    .map((manifest) => ({ manifest, poller: makePoller(manifest) }));

  const llm =
    llmOptions === undefined
      ? undefined
      : new LlmService({
          store,
          bus,
          clock,
          log,
          secrets,
          metrics,
          env: opts.env,
          configDir: llmOptions.configDir,
          providers: llmOptions.providers,
          pricing: llmOptions.pricing,
          defaults: llmOptions.defaults,
          decideDefaults: llmOptions.decideDefaults,
          budgets: llmOptions.budgets,
          factories: llmOptions.factories ?? defaultProviderFactories,
        });

  const executor = new Executor({
    store,
    bus,
    clock,
    log,
    metrics,
    config: () => compiled,
    runners: opts.runners ?? defaultRunners,
    secrets,
    ...(llm === undefined ? {} : { llm }),
    ...(connectors === undefined ? {} : { connectors }),
    ...(agents === undefined ? {} : { agents }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.workers === undefined ? {} : { workers: opts.workers }),
    ...(opts.defaultTimeout === undefined ? {} : { defaultTimeout: opts.defaultTimeout }),
    ...(opts.defaultRetry === undefined ? {} : { defaultRetry: opts.defaultRetry }),
    ...(opts.defaultSandbox === undefined ? {} : { defaultSandbox: opts.defaultSandbox }),
    ...(opts.sandboxHost === undefined ? {} : { sandboxHost: opts.sandboxHost }),
  });

  const retention =
    opts.retention === undefined
      ? undefined
      : new RetentionJob({
          store,
          clock,
          log,
          metrics,
          policy: opts.retention,
          workDir: agents?.workDir,
        });

  metrics.collect(() => {
    const now = clock.now();
    metrics.buildInfo.set({ version: VERSION }, 1);
    if (startedAt !== undefined) {
      metrics.uptime.set(undefined, Math.max(0, (now.getTime() - startedAt.getTime()) / 1000));
    }
    metrics.configTasks.set(undefined, compiled.tasks.length);
    const stats = executor.stats();
    metrics.runsPending.set(undefined, stats.pending);
    metrics.runsInFlight.set(undefined, stats.in_flight);
    metrics.runsWaiting.set(undefined, store.waits.countPending());
    metrics.cronNextRun.reset();
    for (const job of scheduler.list()) {
      if (job.nextRun !== null) {
        metrics.cronNextRun.set({ task: job.task }, job.nextRun.getTime() / 1000);
      }
    }
    metrics.connectorUp.reset();
    for (const c of supervisor?.status() ?? []) {
      metrics.connectorUp.set(
        { connector: c.name, transport: c.transport },
        c.state === 'up' ? 1 : 0,
      );
    }
    for (const { poller } of pollers) {
      metrics.connectorUp.set({ connector: poller.name, transport: 'none' }, 1);
    }
    metrics.spendToday.set(undefined, store.ledger.sumSince(startOfUtcDay(now)));
    metrics.dailyBudget.reset();
    if (llmOptions?.budgets.daily_usd !== undefined) {
      metrics.dailyBudget.set(undefined, llmOptions.budgets.daily_usd);
    }
    const pageCount = store.db.pragma('page_count', { simple: true }) as number;
    const pageSize = store.db.pragma('page_size', { simple: true }) as number;
    metrics.dbSize.set(undefined, pageCount * pageSize);
  });

  /** What the sandbox check judges the tasks against: the manifests and agent settings that will be active. */
  const sandboxContext = (
    ms: readonly ConnectorConfig[],
    ag: { defaults: AgentDefaultsConfig; workDir: string } | undefined,
    shellSandbox: SandboxConfig | undefined,
  ): SandboxCheckContext | undefined =>
    ag === undefined
      ? undefined
      : {
          manifests: ms,
          defaultConnector: ag.defaults.connector,
          workDir: ag.workDir,
          protected: opts.sandboxHost?.protected ?? [],
          defaultSandbox: shellSandbox,
        };

  /** Loads and cross-checks the tasks files without applying anything. */
  const load = (
    files: string[],
    against: CoreLlmOptions | undefined,
    sandboxes: SandboxCheckContext | undefined,
  ): TasksLoadResult => {
    let result = loadTasks(files);
    if (result.ok && result.config !== undefined) {
      result = crossCheck(result, result.config.tasks, against, sandboxes, opts.configFile);
    }
    return result;
  };

  /** Makes a loaded config the active one and warns about dangling connector references. */
  const activate = (result: TasksLoadResult): void => {
    if (!result.ok || result.config === undefined) {
      return;
    }
    compiled = compileConfig(result.config);
    bus.setConfig(compiled);
    const names = new Set(connectors?.names() ?? []);
    const agentNames = new Set(agents?.agentNames() ?? []);
    for (const task of compiled.tasks) {
      for (const ref of connectorRefs(task.config.action)) {
        if (!names.has(ref)) {
          log.warn('core.unknown_connector', { task: task.name, connector: ref });
        }
      }
      const a = task.config.action;
      if (a.kind === 'agent') {
        const ref = a.connector ?? agents?.defaults.connector;
        if (ref === undefined || !agentNames.has(ref)) {
          log.warn('core.unknown_agent', { task: task.name, connector: ref ?? null });
        }
      }
    }
  };

  /** Swaps the built-in pollers to match `next`; unchanged ones keep running. */
  const applyPollers = async (next: readonly ConnectorConfig[]): Promise<void> => {
    const wanted = next.filter((m) => m.builtin !== undefined);
    const keep = new Map(wanted.map((m) => [manifestKey(m), m]));
    const kept: typeof pollers = [];
    const stopping: Promise<void>[] = [];
    for (const entry of pollers) {
      if (keep.delete(manifestKey(entry.manifest))) {
        kept.push(entry);
      } else {
        stopping.push(entry.poller.stop());
      }
    }
    await Promise.all(stopping);
    for (const manifest of keep.values()) {
      const poller = makePoller(manifest);
      kept.push({ manifest, poller });
      poller.start();
    }
    pollers = kept;
  };

  let reloading: Promise<unknown> = Promise.resolve();

  const reload = async (next: CoreReloadOptions = {}): Promise<ReloadResult> => {
    const files = next.tasksFiles ?? tasksFiles;
    const nextLlm = next.llm ?? llmOptions;
    const nextSandbox = 'defaultSandbox' in next ? next.defaultSandbox : defaultSandbox;
    const result = load(
      files,
      nextLlm,
      sandboxContext(
        next.connectors !== undefined && supervisor !== undefined ? next.connectors : manifests,
        next.agents ?? agents,
        nextSandbox,
      ),
    );
    if (!result.ok) {
      metrics.configReloads.inc({ result: 'invalid' });
      log.error('core.config_invalid', {
        files: result.files
          .filter((f) => !f.ok)
          .map((f) => f.file)
          .join(', '),
      });
      return result;
    }
    tasksFiles = files;
    defaultSandbox = nextSandbox;
    if (next.llm !== undefined && llm !== undefined) {
      llmOptions = next.llm;
      llm.configure({
        providers: next.llm.providers,
        pricing: next.llm.pricing,
        defaults: next.llm.defaults,
        decideDefaults: next.llm.decideDefaults,
        budgets: next.llm.budgets,
        configDir: next.llm.configDir,
      });
    }
    executor.configure({
      workers: next.workers,
      defaultTimeout: next.defaultTimeout,
      defaultRetry: next.defaultRetry,
      ...('defaultSandbox' in next ? { defaultSandbox: next.defaultSandbox } : {}),
    });
    if (next.maxEventDepth !== undefined) {
      bus.dispatcher.configure({ maxDepth: next.maxEventDepth });
    }
    if (next.agents !== undefined) {
      await supervisor?.configure(next.agents);
    }
    let applied: ApplyResult | undefined;
    if (next.connectors !== undefined && supervisor !== undefined) {
      manifests = next.connectors;
      applied = await supervisor.apply(manifests.filter((m) => m.builtin === undefined));
      await applyPollers(manifests);
    }
    if (next.retention !== undefined) {
      retention?.configure(next.retention, agents?.workDir);
    }
    activate(result);
    scheduler.reload(compiled);
    metrics.configReloads.inc({ result: 'ok' });
    log.info('core.config_reloaded', {
      tasks: compiled.tasks.length,
      connectors_added: joined(applied?.added),
      connectors_removed: joined(applied?.removed),
      connectors_changed: joined(applied?.changed),
    });
    return applied === undefined ? result : { ...result, connectors: applied };
  };

  return {
    bus,
    store,
    scheduler,
    executor,
    metrics,
    supervisor,
    get pollers() {
      return pollers.map((p) => p.poller);
    },
    retention,
    config: () => compiled,
    start: async () => {
      const result = load(
        tasksFiles,
        llmOptions,
        sandboxContext(manifests, agents, defaultSandbox),
      );
      if (!result.ok) {
        throw new ConfigLoadError(result);
      }
      activate(result);
      startedAt = clock.now();
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
      for (const { poller } of pollers) {
        poller.start();
      }
      retention?.start();
    },
    reload: (next) => {
      // Reloads are serialised: two SIGHUPs in a row apply in order, never interleaved.
      const run = reloading.then(() => reload(next));
      reloading = run.catch(() => undefined);
      return run;
    },
    runTask: (name, input) => runTaskManually(bus, store, compiled, name, input),
    stop: async () => {
      scheduler.stop();
      bus.dispatcher.stop();
      await retention?.stop();
      await executor.stop();
      await Promise.all(pollers.map((p) => p.poller.stop()));
      await supervisor?.stop();
      store.close();
    },
  };
}

/** A name list for a log field: comma-separated, or null when empty. */
function joined(names: readonly string[] | undefined): string | null {
  return names === undefined || names.length === 0 ? null : names.join(',');
}

/**
 * Applies `checkLlmTasks`, `checkSandboxes` and `checkAgentTools` to a merged load; an issue on a task fails
 * the file the task came from, one on a manifest or on agent.yaml is reported under that
 * file.
 */
function crossCheck(
  result: TasksLoadResult,
  tasks: readonly CompiledConfig['tasks'][number]['config'][],
  llm: CoreLlmOptions | undefined,
  sandboxes: SandboxCheckContext | undefined,
  configFile: string | undefined,
): TasksLoadResult {
  const issues = llm === undefined ? [] : checkLlmTasks(tasks, llm);
  const sb = sandboxes === undefined ? undefined : checkSandboxes(tasks, sandboxes);
  issues.push(...(sb?.tasks ?? []));
  if (sandboxes !== undefined) {
    issues.push(...checkAgentTools(tasks, sandboxes.manifests));
  }
  // One entry per file: an inline manifest's issues and agent.yaml's own share a file.
  const byFile = new Map<string, ConfigIssue[]>();
  const under = (file: string, list: ConfigIssue[]): void => {
    if (list.length > 0) {
      byFile.set(file, [...(byFile.get(file) ?? []), ...list]);
    }
  };
  for (const m of sb?.manifests ?? []) {
    under(m.file, m.issues);
  }
  under(configFile ?? 'agent.yaml', sb?.agent ?? []);
  const extra: TasksLoadResult['files'] = [...byFile].map(([file, list]) => ({
    ok: false as const,
    file,
    issues: list,
  }));
  if (issues.length === 0 && extra.length === 0) {
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
  return { ok: false, files: [...files, ...extra] };
}

/** Connector names an action (or its sequence steps) calls ops on; `agent` connectors are checked separately. */
function connectorRefs(action: CompiledConfig['tasks'][number]['config']['action']): string[] {
  if (action.kind === 'connector') {
    return [action.connector];
  }
  if (action.kind === 'sequence') {
    return action.steps.flatMap((s) => (s.kind === 'connector' ? [s.connector] : []));
  }
  return [];
}
