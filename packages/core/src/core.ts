import { statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { runAgent } from './actions/agent.js';
import type { AgentDefaultsConfig } from './actions/agent-config.js';
import { runConnector } from './actions/connector.js';
import { runDecide } from './actions/decide.js';
import { runLlm } from './actions/llm.js';
import { bwrapUsers, probeBwrap, type BwrapProbeResult } from './actions/bwrap-probe.js';
import { netProxyDir } from './actions/sandbox-net.js';
import { runSequence } from './actions/sequence.js';
import type { SandboxConfig, SandboxHost } from './actions/sandbox.js';
import { runShell } from './actions/shell.js';
import type { ActionRunners, AgentClients, ConnectorClients } from './actions/types.js';
import { runWait } from './actions/wait.js';
import { createBus, type EventBus } from './bus/bus.js';
import { runTaskManually, type ManualInput } from './bus/manual.js';
import { listTasks, pauseTask, resumeTask, type TaskEntry, type TaskInfo } from './bus/pause.js';
import { compileConfig, type CompiledConfig } from './bus/matcher.js';
import { systemClock, type Clock } from './clock.js';
import type { ConnectorConfig } from './config/connector.js';
import {
  checkAgentTools,
  checkConnectorActions,
  checkLlmTasks,
  checkSandboxes,
  type SandboxCheckContext,
} from './config/crosscheck.js';
import { formatIssue } from './config/format.js';
import { lintIssues } from './config/lint.js';
import { loadTasks, type ConfigIssue, type TasksLoadResult } from './config/load.js';
import type { RetentionPolicy } from './config/retention.js';
import type { RetryConfig } from './config/schema.js';
import { taskActions } from './config/walk.js';
import { Poller } from './connectors/poller.js';
import { ConnectorSupervisor, manifestKey, type ApplyResult } from './connectors/supervisor.js';
import { Executor } from './executor/executor.js';
import { BatchPoller } from './llm/batches.js';
import type {
  BatchesConfig,
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
import { parseDuration } from './config/duration.js';
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
  /** Runs one causal chain may start; past it, its events start no run. */
  maxChainRuns?: number;
  /** Runs in flight across all tasks. */
  workers?: number;
  /** For tasks without `timeout`. */
  defaultTimeout?: string;
  /** For tasks without `retry`. */
  defaultRetry?: RetryConfig;
  /** For `shell` actions without `sandbox`. */
  defaultSandbox?: SandboxConfig;
  /** How long `stop()` lets runs in flight finish before aborting them; defaults to none. */
  stopGrace?: string;
  /** What every sandbox (shell or agent program) hides and shows on this host; fixed for the process. */
  sandboxHost?: SandboxHost;
  /**
   * Whether bwrap can start a sandbox here, run at start and on reload when anything is in
   * bwrap; defaults to `probeBwrap()` (tests pass a stub).
   */
  bwrapProbe?: () => Promise<BwrapProbeResult>;
  /** The agent.yaml the settings came from, named in issues about it; defaults to none. */
  configFile?: string;
  /** Action runners by kind; defaults to the built-in ones. */
  runners?: ActionRunners;
  /** `${secrets.<name>}` backend; defaults to one with no secrets. */
  secrets?: SecretsBackend;
  /** The `env` template scope; defaults to none. */
  env?: Record<string, string>;
  /**
   * What a child the daemon starts outside a sandbox gets (`shell` steps, `post` gates,
   * the workspace git); defaults to `secrets.scrub(process.env)`.
   */
  childEnv?: Record<string, string>;
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
  /** `batches:`; polled every minute when omitted. */
  batches?: BatchesConfig | undefined;
  /** Adapters by provider type; defaults to the built-in ones. */
  factories?: ProviderFactories;
}

/**
 * What a reload may change (docs/internal/architecture.md, docs/internal/packaging.md): everything from agent.yaml except the
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
  stopGrace?: string | undefined;
  maxEventDepth?: number | undefined;
  maxChainRuns?: number | undefined;
  retention?: RetentionPolicy | undefined;
}

export interface ReloadResult extends TasksLoadResult {
  /** What happened to the supervised connectors, when the reload changed them. */
  connectors?: ApplyResult | undefined;
  /**
   * Why a valid config could not be applied (a connector change failed); with `ok: false`,
   * and the previous config still fully active.
   */
  error?: string | undefined;
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
  /** Polls the batches of `batch: true` llm actions, when providers are configured. */
  readonly batchPoller: BatchPoller | undefined;
  config(): CompiledConfig;
  /**
   * Loads config, opens the store, recovers runs, dispatches any backlog, arms cron jobs
   * and spawns connectors. Throws on invalid config. Resolves without waiting for the
   * connectors to come up: a slow one shows as `starting` meanwhile (#195).
   */
  start(): Promise<void>;
  /**
   * Re-reads the tasks files and applies `next` (new agent.yaml settings). All or nothing:
   * an invalid tasks file is logged, nothing changes and the previous config stays active;
   * a connector change that fails is undone and reported as `ok: false` with `error`. No
   * run starts while a reload applies; runs in flight finish under the settings they
   * started with.
   */
  reload(next?: CoreReloadOptions): Promise<ReloadResult>;
  /** `oa run <task>`: queue a run for any task, with an optional input event. */
  runTask(name: string, input?: ManualInput): { event_id: string; run: RunRecord };
  /**
   * `oa runs cancel <id>`: ends a queued, running or waiting run as `cancelled`
   * (`Executor.cancel`). `undefined` for an unknown run.
   */
  cancelRun(id: string): Promise<RunRecord | undefined>;
  /** `oa tasks ls`: the configured tasks, their triggers, pauses, next fire and last runs. */
  listTasks(): TaskEntry[];
  /** `oa tasks pause <task>`: no new runs until resumed; throws `UnknownTaskError`. */
  pauseTask(name: string): TaskEntry;
  /** `oa tasks resume <task>`; throws `UnknownTaskError`. */
  resumeTask(name: string): TaskEntry;
  /**
   * Lets runs in flight finish within the stop grace window, aborts the rest (they are run
   * again on the next start), stops connectors, closes the store. `grace: false` skips the
   * window.
   */
  stop(opts?: { grace?: boolean }): Promise<void>;
}

export class ConfigLoadError extends Error {
  constructor(readonly result: TasksLoadResult) {
    super(
      'invalid config:\n' +
        result.files
          .flatMap((f) => (f.ok ? [] : f.issues.map((i) => `  ${formatIssue(f.file, i)}`)))
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

/**
 * Logs every issue of every invalid file as its own error line (`file`, `path`, `issue`,
 * and `task` and `line` when the issue carries them), so a reload refused on SIGHUP
 * explains itself in the journal (#44).
 */
export function logConfigIssues(
  log: Logger,
  msg: string,
  files: readonly { file: string; ok: boolean; issues?: readonly ConfigIssue[] | undefined }[],
): void {
  for (const f of files) {
    if (f.ok) {
      continue;
    }
    for (const issue of f.issues ?? []) {
      log.error(msg, {
        file: f.file,
        path: issue.path,
        ...(issue.task === undefined ? {} : { task: issue.task }),
        ...(issue.line === undefined ? {} : { line: issue.line }),
        issue: issue.message,
      });
    }
  }
}

export function createCore(opts: CoreOptions): Core {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? createLogger();
  const metrics = opts.metrics ?? new Metrics();
  const secrets = opts.secrets ?? staticSecrets({});
  const childEnv = opts.childEnv ?? secrets.scrub(process.env);
  const store = openStore(opts.dbPath);
  const bus = createBus({
    store,
    clock,
    log,
    metrics,
    ...(opts.maxEventDepth === undefined ? {} : { maxDepth: opts.maxEventDepth }),
    ...(opts.maxChainRuns === undefined ? {} : { maxChainRuns: opts.maxChainRuns }),
  });
  const scheduler = new CronScheduler({ bus, clock, log, metrics });
  const taskInfo: TaskInfo = { store, nextFire: (task) => scheduler.nextRun(task) };
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
          templateEnv: childEnv,
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

  const batchPollMs = (o: CoreLlmOptions): number => parseDuration(o.batches?.poll ?? '1m');
  const batchPoller =
    llm === undefined || llmOptions === undefined
      ? undefined
      : new BatchPoller({ source: llm, log, intervalMs: batchPollMs(llmOptions) });

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
    childEnv,
    ...(opts.workers === undefined ? {} : { workers: opts.workers }),
    ...(opts.defaultTimeout === undefined ? {} : { defaultTimeout: opts.defaultTimeout }),
    ...(opts.defaultRetry === undefined ? {} : { defaultRetry: opts.defaultRetry }),
    ...(opts.defaultSandbox === undefined ? {} : { defaultSandbox: opts.defaultSandbox }),
    ...(opts.stopGrace === undefined ? {} : { stopGrace: opts.stopGrace }),
    ...(opts.sandboxHost === undefined ? {} : { sandboxHost: opts.sandboxHost }),
  });

  const retention =
    opts.retention === undefined
      ? undefined
      : new RetentionJob({
          store,
          bus,
          clock,
          log,
          metrics,
          policy: opts.retention,
          workDir: agents?.workDir,
          env: childEnv,
        });

  metrics.collect(() => {
    const now = clock.now();
    metrics.buildInfo.set({ version: VERSION }, 1);
    if (startedAt !== undefined) {
      metrics.uptime.set(undefined, Math.max(0, (now.getTime() - startedAt.getTime()) / 1000));
    }
    metrics.configTasks.set(undefined, compiled.tasks.length);
    metrics.tasksPaused.set(
      undefined,
      store.pauses.list().filter((p) => compiled.byName.has(p.task)).length,
    );
    const stats = executor.stats();
    metrics.runsPending.set(undefined, stats.pending);
    metrics.runsInFlight.set(undefined, stats.in_flight);
    metrics.runsWaiting.set(undefined, store.waits.countPending());
    const oldest = store.runs.oldestCreatedAt('queued');
    metrics.oldestPendingAge.set(
      undefined,
      oldest === undefined ? 0 : Math.max(0, (now.getTime() - Date.parse(oldest)) / 1000),
    );
    metrics.eventsUndispatched.set(
      undefined,
      store.events.countAfter(store.cursors.get('dispatch')),
    );
    // Present at 0 from startup, so rate() and absent() work before the first run (#90).
    for (const task of compiled.tasks) {
      const labels = { task: task.name };
      metrics.runsQueued.init(labels);
      metrics.runAttempts.init(labels);
      metrics.runsInterrupted.init(labels);
      for (const status of ['succeeded', 'failed', 'cancelled']) {
        metrics.runsFinished.init({ ...labels, status });
      }
    }
    metrics.taskLastSuccess.reset();
    for (const [task, seconds] of metrics.lastSuccess) {
      if (compiled.byName.has(task)) {
        metrics.taskLastSuccess.set({ task }, seconds);
      }
    }
    metrics.llmBatchesPending.set(undefined, store.batches.count());
    metrics.cronNextRun.reset();
    for (const job of scheduler.list()) {
      if (job.nextRun !== null) {
        metrics.cronNextRun.set({ task: job.task }, job.nextRun.getTime() / 1000);
      }
    }
    metrics.connectorUp.reset();
    // An external connector (its own unit, no ops) has nothing the core can observe.
    for (const c of (supervisor?.status() ?? []).filter((s) => s.state !== 'external')) {
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
    metrics.dbWalSize.set(undefined, fileSize(`${opts.dbPath}-wal`));
    const free = opts.dbPath === ':memory:' ? undefined : diskFree(dirname(opts.dbPath));
    metrics.dbDiskFree.reset();
    if (free !== undefined) {
      metrics.dbDiskFree.set(undefined, free);
    }
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
          netProxyDir: opts.socketPath === undefined ? undefined : netProxyDir(opts.socketPath),
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

  /**
   * Makes a loaded config the active one and warns about dangling connector references and
   * about what `oa validate` warns about (`config/lint.ts`), at start and on every reload.
   */
  const activate = (result: TasksLoadResult): void => {
    if (!result.ok || result.config === undefined) {
      return;
    }
    compiled = compileConfig(result.config);
    bus.setConfig(compiled);
    for (const f of result.files) {
      if (!f.ok) {
        continue;
      }
      for (const w of f.locate(lintIssues(f.config.tasks, result.config.tasks))) {
        log.warn('core.config_warning', {
          task: w.task,
          file: f.file,
          path: w.path,
          ...(w.line === undefined ? {} : { line: w.line }),
          warning: w.message,
        });
      }
    }
    const names = new Set(connectors?.names() ?? []);
    const agentNames = new Set(agents?.agentNames() ?? []);
    for (const task of compiled.tasks) {
      for (const ref of connectorRefs(task.config)) {
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

  /**
   * Warns, without failing, when something active runs in bwrap and bwrap cannot start a
   * sandbox on this host (missing package, user namespaces restricted).
   */
  const checkBwrap = async (): Promise<void> => {
    const users = bwrapUsers(
      compiled.tasks.map((t) => t.config),
      defaultSandbox,
      manifests,
    );
    if (users.length === 0) {
      return;
    }
    const probe = await (opts.bwrapProbe ?? probeBwrap)();
    if (!probe.ok) {
      log.warn('core.sandbox_unavailable', { cause: probe.cause, used_by: users.join(', ') });
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
    // Tracked from here on, so a throw below leaves `pollers` listing exactly what runs and
    // an undo starts the stopped ones again instead of keeping them by key.
    pollers = kept;
    for (const manifest of keep.values()) {
      const poller = makePoller(manifest);
      poller.start();
      kept.push({ manifest, poller });
    }
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
      logConfigIssues(log, 'core.config_invalid', result.files);
      return result;
    }
    // All or nothing (#77): no run starts until the reload is through, so none sees half
    // of it. The steps that take time or can fail (connectors respawning) go first and are
    // undone on failure; everything else then switches in one synchronous step.
    const release = executor.hold();
    let applied: ApplyResult | undefined;
    try {
      try {
        applied = await applyConnectors(next);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        metrics.configReloads.inc({ result: 'failed' });
        log.error('core.reload_failed', { error });
        return { ...result, ok: false, error };
      }
      switchTo(next, files, nextSandbox, result);
    } finally {
      // Before the bwrap probe: the config is consistent from here on.
      release();
    }
    await checkBwrap();
    metrics.configReloads.inc({ result: 'ok' });
    log.info('core.config_reloaded', {
      tasks: compiled.tasks.length,
      connectors_added: joined(applied?.added),
      connectors_removed: joined(applied?.removed),
      connectors_changed: joined(applied?.changed),
    });
    return applied === undefined ? result : { ...result, connectors: applied };
  };

  /**
   * The part of a reload that waits on processes: agent defaults, the supervised connector
   * set and the pollers. When a step throws, the previous set is put back before the error
   * is passed on, so the reload changes nothing.
   */
  const applyConnectors = async (next: CoreReloadOptions): Promise<ApplyResult | undefined> => {
    if (supervisor === undefined) {
      return undefined;
    }
    const sup = supervisor;
    const before = {
      agents: { defaults: sup.defaults, workDir: sup.workDir },
      manifests,
    };
    try {
      if (next.agents !== undefined) {
        await sup.configure(next.agents);
      }
      if (next.connectors === undefined) {
        return undefined;
      }
      const applied = await sup.apply(next.connectors.filter((m) => m.builtin === undefined));
      await applyPollers(next.connectors);
      manifests = next.connectors;
      return applied;
    } catch (err) {
      try {
        await sup.configure(before.agents);
        await sup.apply(before.manifests.filter((m) => m.builtin === undefined));
        await applyPollers(before.manifests);
      } catch (undo) {
        log.error('core.reload_undo_failed', {
          error: undo instanceof Error ? undo.message : String(undo),
        });
      }
      throw err;
    }
  };

  /** The rest of a reload, synchronous so that no run can start in between. */
  const switchTo = (
    next: CoreReloadOptions,
    files: string[],
    nextSandbox: SandboxConfig | undefined,
    result: TasksLoadResult,
  ): void => {
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
      batchPoller?.configure(batchPollMs(next.llm));
    }
    executor.configure({
      workers: next.workers,
      defaultTimeout: next.defaultTimeout,
      defaultRetry: next.defaultRetry,
      stopGrace: next.stopGrace,
      ...('defaultSandbox' in next ? { defaultSandbox: next.defaultSandbox } : {}),
    });
    if (next.maxEventDepth !== undefined || next.maxChainRuns !== undefined) {
      bus.dispatcher.configure({
        ...(next.maxEventDepth === undefined ? {} : { maxDepth: next.maxEventDepth }),
        ...(next.maxChainRuns === undefined ? {} : { maxChainRuns: next.maxChainRuns }),
      });
    }
    if (next.retention !== undefined) {
      retention?.configure(next.retention, agents?.workDir);
    }
    activate(result);
    scheduler.reload(compiled);
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
    batchPoller,
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
      // Once per start: the executor keeps it current, so no scrape reads the runs table.
      for (const { task, finished_at } of store.runs.lastSucceeded()) {
        metrics.recordSuccess(task, Date.parse(finished_at) / 1000);
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
      await checkBwrap();
      // Not awaited: a connector hanging in setup must not hold up the API or the jobs
      // below. The supervisor logs and retries a failed spawn; the catch is a backstop.
      supervisor?.start().catch((err: unknown) => {
        log.error('core.connectors_start_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      for (const { poller } of pollers) {
        poller.start();
      }
      retention?.start();
      batchPoller?.start();
    },
    reload: (next) => {
      // Reloads are serialised: two SIGHUPs in a row apply in order, never interleaved.
      const run = reloading.then(() => reload(next));
      reloading = run.catch(() => undefined);
      return run;
    },
    runTask: (name, input) => runTaskManually(bus, store, compiled, name, input),
    cancelRun: (id) => executor.cancel(id),
    listTasks: () => listTasks(taskInfo, compiled),
    pauseTask: (name) => pauseTask(taskInfo, compiled, clock, log, name),
    resumeTask: (name) => resumeTask(taskInfo, compiled, log, name),
    stop: async (stopOpts = {}) => {
      scheduler.stop();
      bus.dispatcher.stop();
      await retention?.stop();
      await batchPoller?.stop();
      await executor.stop(stopOpts);
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
 * Applies `checkLlmTasks`, `checkSandboxes`, `checkAgentTools` and `checkConnectorActions` to a
 * merged load; an issue on a task fails the file the task came from, one on a manifest or on agent.yaml is reported under that
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
    issues.push(...checkConnectorActions(tasks, sandboxes.manifests));
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
    return own.length === 0 ? f : { ok: false as const, file: f.file, issues: f.locate(own) };
  });
  return { ok: false, files: [...files, ...extra] };
}

/** Connector names an action (or its sequence steps) calls ops on; `agent` connectors are checked separately. */
function connectorRefs(task: CompiledConfig['tasks'][number]['config']): string[] {
  return taskActions(task, 'action').flatMap(({ action }) =>
    action.kind === 'connector' ? [action.connector] : [],
  );
}

/** A file's size, 0 when it does not exist (no WAL yet, or an in-memory database). */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Bytes an unprivileged writer can still use on the file system holding `dir`. */
function diskFree(dir: string): number | undefined {
  try {
    const fs = statfsSync(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return undefined;
  }
}
