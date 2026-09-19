import type { ActionRunners } from './actions/types.js';
import { createApiServer, type ApiServer } from './api/server.js';
import { systemClock, type Clock } from './clock.js';
import { loadAgentFile, type AgentConfig, type AgentLoadResult } from './config/agent.js';
import type { LoadResult } from './config/load.js';
import { createCore, type Core } from './core.js';
import { createLogger, type Logger, type LogLevel } from './log.js';

export interface DaemonOptions {
  /** Path of `agent.yaml`. */
  configFile: string;
  /** Overrides `log.level` from the file. */
  logLevel?: LogLevel;
  /** Defaults to a JSON-lines logger on stdout at the configured level. */
  log?: Logger;
  clock?: Clock;
  runners?: ActionRunners;
}

export interface Daemon {
  readonly config: AgentConfig;
  readonly core: Core;
  readonly api: ApiServer;
  /** SIGHUP: re-reads the tasks file; `agent.yaml` itself needs a restart. */
  reload(): LoadResult;
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

/**
 * The whole process, minus signal handling (`main.ts`): agent config → core → socket API.
 * Throws `AgentConfigError` / `ConfigLoadError` on a bad config and whatever `listen`
 * throws when the socket is taken; nothing is left open in that case.
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const loaded = loadAgentFile(opts.configFile);
  if (!loaded.ok) {
    throw new AgentConfigError(loaded);
  }
  const config = loaded.config;
  const clock = opts.clock ?? systemClock;
  const log =
    opts.log ??
    createLogger({ level: opts.logLevel ?? config.log.level, clock: () => clock.now() });
  const startedAt = clock.now();

  const core = createCore({
    tasksFile: config.tasks,
    dbPath: config.db,
    clock,
    log,
    workers: config.workers,
    maxEventDepth: config.limits.max_event_depth,
    defaultTimeout: config.defaults.timeout,
    ...(opts.runners === undefined ? {} : { runners: opts.runners }),
  });
  const api = createApiServer({
    core,
    clock,
    log,
    startedAt,
    configFile: config.file,
    socketPath: config.socket,
  });

  try {
    core.start();
    await api.listen();
  } catch (err) {
    await api.close();
    await core.stop();
    throw err;
  }
  log.info('daemon.started', { config_file: config.file, db: config.db, socket: config.socket });

  let stopping: Promise<void> | undefined;
  return {
    config,
    core,
    api,
    reload: () => core.reload(),
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
