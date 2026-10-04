import { dirname } from 'node:path';

import type { ActionRunners, AgentClients, ConnectorClients } from './actions/types.js';
import { createApiServer, type ApiServer } from './api/server.js';
import { systemClock, type Clock } from './clock.js';
import {
  loadAgentFile,
  protectedPaths,
  type AgentConfig,
  type AgentLoadResult,
} from './config/agent.js';
import { loadConnectors, type ConfigIssue } from './config/load.js';
import { retentionPolicy } from './config/retention.js';
import type { ApplyResult } from './connectors/supervisor.js';
import type { AgentDefaultsConfig } from './actions/agent-config.js';
import { sandboxHost, type SandboxConfig } from './actions/sandbox.js';
import type { RetentionPolicy } from './config/retention.js';
import type { RetryConfig } from './config/schema.js';
import { createCore, type Core, type CoreLlmOptions } from './core.js';
import { PricingError, resolvePricing, type PricingTable } from './llm/pricing.js';
import type { ProviderFactories } from './llm/types.js';
import { createLogger, type Logger, type LogLevel } from './log.js';
import { Metrics } from './metrics.js';
import { createSecretsBackend } from './secrets/secrets.js';

export interface DaemonOptions {
  /** Path of `agent.yaml`. */
  configFile: string;
  /** Overrides `log.level` from the file. */
  logLevel?: LogLevel;
  /** Defaults to a JSON-lines logger on stdout at the configured level. */
  log?: Logger;
  clock?: Clock;
  runners?: ActionRunners;
  /** Replaces the connector supervisor (tests). */
  connectors?: ConnectorClients;
  /** Replaces the supervisor's agent sessions (tests). */
  agents?: AgentClients;
  /** The daemon's environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Replaces the built-in provider adapters (tests). */
  llmFactories?: ProviderFactories;
}

/** One config file as a reload saw it. */
export interface ReloadFile {
  file: string;
  ok: boolean;
  issues?: ConfigIssue[] | undefined;
}

/**
 * What `reload()` did (docs/internal/architecture.md, docs/internal/packaging.md). `ok: false` means nothing changed: the
 * files with issues are listed and the previous config stays active.
 */
export interface ReloadReport {
  ok: boolean;
  /** agent.yaml, then the manifests, then the tasks files. */
  files: ReloadFile[];
  /** Keys of agent.yaml that changed but only take effect on a restart (`db`, `socket`, `secrets`). */
  restart_required: string[];
  /** Connectors added, removed or respawned with a new manifest. */
  connectors?: ApplyResult | undefined;
  /** Tasks in the active config after the reload. */
  tasks: number;
}

export interface Daemon {
  /** The active agent config; a successful reload replaces it. */
  readonly config: AgentConfig;
  readonly core: Core;
  readonly api: ApiServer;
  /**
   * SIGHUP or `POST /v1/reload`: re-reads agent.yaml, the connector manifests and the
   * tasks files and applies them together, or nothing when any of them is invalid. `db`,
   * `socket` and `secrets` need a restart and are reported as such.
   */
  reload(): Promise<ReloadReport>;
  /** Closes the socket, aborts runs in flight, closes the store. */
  stop(): Promise<void>;
}

export class AgentConfigError extends Error {
  constructor(readonly result: Extract<AgentLoadResult, { ok: false }>) {
    super(
      `invalid agent config ${result.file}:\n` +
        result.issues.map((i) => `  ${i.path === '' ? '' : i.path + ': '}${i.message}`).join('\n'),
    );
    this.name = 'AgentConfigError';
  }
}

export class ConnectorConfigError extends Error {
  constructor(readonly result: ReturnType<typeof loadConnectors>) {
    super(
      'invalid connector config:\n' +
        result.files
          .flatMap((f) =>
            (f.issues ?? []).map(
              (i) => `  ${f.file}: ${i.path === '' ? '' : i.path + ': '}${i.message}`,
            ),
          )
          .join('\n'),
    );
    this.name = 'ConnectorConfigError';
  }
}

/** The `env` template scope: the daemon's environment minus the secrets backend's variables. */
export function templateEnv(
  env: NodeJS.ProcessEnv,
  secretPrefix: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (secretPrefix === undefined || !k.startsWith(secretPrefix))) {
      out[k] = v;
    }
  }
  return out;
}

/** agent.yaml keys the core cannot swap while running. */
const FIXED_KEYS = ['db', 'socket', 'secrets'] as const;

/** Reads agent.yaml and resolves its pricing; both failures come back as an issue list. */
function readAgentConfig(
  path: string,
):
  | { ok: true; config: AgentConfig; pricing: PricingTable }
  | Extract<AgentLoadResult, { ok: false }> {
  const loaded = loadAgentFile(path);
  if (!loaded.ok) {
    return loaded;
  }
  try {
    return { ok: true, config: loaded.config, pricing: resolvePricing(loaded.config.pricing) };
  } catch (err) {
    if (err instanceof PricingError) {
      return {
        ok: false,
        file: loaded.config.file,
        issues: [{ path: `pricing.${err.model}`, message: err.message }],
      };
    }
    throw err;
  }
}

/** Everything the core takes from agent.yaml that a reload may change. */
interface CoreSettings {
  tasksFiles: string[];
  workers: number;
  maxEventDepth: number;
  defaultTimeout: string;
  defaultRetry: RetryConfig;
  defaultSandbox: SandboxConfig;
  agents: { defaults: AgentDefaultsConfig; workDir: string };
  llm: CoreLlmOptions;
  retention: RetentionPolicy;
}

function coreSettings(
  config: AgentConfig,
  pricing: PricingTable,
  factories: ProviderFactories | undefined,
): CoreSettings {
  return {
    tasksFiles: config.tasks,
    workers: config.workers,
    maxEventDepth: config.limits.max_event_depth,
    defaultTimeout: config.defaults.timeout,
    defaultRetry: config.defaults.retry,
    defaultSandbox: config.defaults.sandbox,
    agents: { defaults: config.defaults.agent, workDir: config.workDir },
    llm: {
      providers: config.providers,
      pricing,
      defaults: config.defaults.llm,
      decideDefaults: config.defaults.decide,
      budgets: config.budgets,
      batches: config.batches,
      configDir: dirname(config.file),
      ...(factories === undefined ? {} : { factories }),
    },
    retention: retentionPolicy(config.retention),
  };
}

/**
 * The whole process, minus signal handling (`main.ts`): agent config → core → socket API.
 * Throws `AgentConfigError` / `ConfigLoadError` on a bad config and whatever `listen`
 * throws when the socket is taken; nothing is left open in that case.
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const read = readAgentConfig(opts.configFile);
  if (!read.ok) {
    throw new AgentConfigError(read);
  }
  let config = read.config;
  const clock = opts.clock ?? systemClock;
  const log =
    opts.log ??
    createLogger({ level: opts.logLevel ?? config.log.level, clock: () => clock.now() });
  const startedAt = clock.now();
  const env = opts.env ?? process.env;
  const secrets = createSecretsBackend(config.secrets, dirname(config.file), env);
  const manifests = loadConnectors(config.connectorPaths, config.connectors);
  if (!manifests.ok) {
    throw new ConnectorConfigError(manifests);
  }
  const metrics = new Metrics();

  // What no sandbox may see, and what every one needs: fixed like `db` and `secrets`.
  const host = sandboxHost({ protected: protectedPaths(config), env });

  const core = createCore({
    ...coreSettings(config, read.pricing, opts.llmFactories),
    dbPath: config.db,
    configFile: config.file,
    sandboxHost: host,
    clock,
    log,
    metrics,
    secrets,
    env: templateEnv(env, config.secrets.backend === 'env' ? config.secrets.prefix : undefined),
    socketPath: config.socket,
    connectors: opts.connectors ?? manifests.connectors ?? [],
    ...(opts.agents === undefined ? {} : { agents: opts.agents }),
    ...(opts.runners === undefined ? {} : { runners: opts.runners }),
  });

  // What the process actually runs with: a reload never swaps these, so they are
  // compared against (and kept in `config`) until a restart.
  const fixed = { db: config.db, socket: config.socket, secrets: config.secrets };

  const reload = async (): Promise<ReloadReport> => {
    const tasks = (): number => core.config().tasks.length;
    const next = readAgentConfig(opts.configFile);
    if (!next.ok) {
      log.error('daemon.reload_invalid', { file: next.file });
      core.metrics.configReloads.inc({ result: 'invalid' });
      return {
        ok: false,
        files: [{ file: next.file, ok: false, issues: next.issues }],
        restart_required: [],
        tasks: tasks(),
      };
    }
    const restartRequired = FIXED_KEYS.filter(
      (k) => JSON.stringify(next.config[k]) !== JSON.stringify(fixed[k]),
    );
    if (restartRequired.length > 0) {
      log.warn('daemon.reload_needs_restart', { keys: restartRequired.join(',') });
    }
    const files: ReloadFile[] = [{ file: next.config.file, ok: true }];
    const nextManifests = loadConnectors(next.config.connectorPaths, next.config.connectors);
    for (const f of nextManifests.files) {
      if (f.file !== next.config.file) {
        files.push({ file: f.file, ok: f.ok, issues: f.issues });
      } else if (!f.ok) {
        files[0] = { file: f.file, ok: false, issues: f.issues };
      }
    }
    if (!nextManifests.ok) {
      log.error('daemon.reload_invalid', {
        files: files
          .filter((f) => !f.ok)
          .map((f) => f.file)
          .join(', '),
      });
      core.metrics.configReloads.inc({ result: 'invalid' });
      return { ok: false, files, restart_required: restartRequired, tasks: tasks() };
    }
    const result = await core.reload({
      ...coreSettings(next.config, next.pricing, opts.llmFactories),
      // Ready-made clients (tests) are not manifests; leave them alone.
      ...(opts.connectors === undefined ? { connectors: nextManifests.connectors ?? [] } : {}),
    });
    for (const f of result.files) {
      files.push(f.ok ? { file: f.file, ok: true } : { file: f.file, ok: false, issues: f.issues });
    }
    if (result.ok) {
      config = { ...next.config, ...fixed };
      log.setLevel?.(opts.logLevel ?? config.log.level);
      log.info('daemon.reloaded', { tasks: tasks(), config_file: config.file });
    }
    return {
      ok: result.ok,
      files,
      restart_required: restartRequired,
      connectors: result.connectors,
      tasks: tasks(),
    };
  };

  const api = createApiServer({
    core,
    clock,
    log,
    startedAt,
    configFile: config.file,
    socketPath: config.socket,
    reload,
  });

  try {
    await core.start();
    await api.listen();
  } catch (err) {
    await api.close();
    await core.stop();
    throw err;
  }
  log.info('daemon.started', { config_file: config.file, db: config.db, socket: config.socket });

  let stopping: Promise<void> | undefined;
  return {
    get config() {
      return config;
    },
    core,
    api,
    reload,
    stop: () => {
      stopping ??= (async () => {
        log.info('daemon.stopping');
        await api.close();
        await core.stop();
        log.info('daemon.stopped');
      })();
      return stopping;
    },
  };
}
