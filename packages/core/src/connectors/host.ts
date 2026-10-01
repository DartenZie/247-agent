/**
 * `247-agent-connector-host`: what a `247-agent-connector@<name>` unit runs (ARCHITECTURE
 * §6). It reads the same agent.yaml and manifests as the daemon, finds the connector
 * `<name>` (which must say `managed_by: systemd`), resolves its secrets from the unit's
 * own secrets backend (its `LoadCredential=` lines with `systemd-credentials`) and runs
 * its `exec` with the environment the supervisor would have given it:
 *
 * - `transport: none`: runs the process for the life of the unit and exits with it, so
 *   systemd's `Restart=` does what the supervisor's backoff does for a child.
 * - `transport: stdio`: listens on the unit's socket and, for each connection from the
 *   core, spawns the connector and bridges the connection to its stdin/stdout. A new
 *   connection replaces the old one; a closed connection stops the process. Config and
 *   secrets are read again for every process, so `oa connector restart` (which reconnects)
 *   picks up a rotated secret or a changed manifest.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

import { loadAgentFile } from '../config/agent.js';
import { unitSocket, type ConnectorConfig } from '../config/connector.js';
import { loadConnectors, type ConfigIssue } from '../config/load.js';
import { createSecretsBackend } from '../secrets/secrets.js';
import { connectorChildEnv } from './supervisor.js';

export interface ConnectorHostOptions {
  /** agent.yaml, as the daemon reads it. */
  configFile: string;
  /** The connector's manifest name (the unit's instance, `%i`). */
  name: string;
  /** The unit's environment: `CREDENTIALS_DIRECTORY`, `OA_SECRET_*`, `PATH`, … */
  env: NodeJS.ProcessEnv;
  /** Overrides the socket a stdio connector listens on (tests, running it by hand). */
  socket?: string | undefined;
  log: (line: string) => void;
  /** Grace period between SIGTERM and SIGKILL when stopping the process. */
  killTimeoutMs?: number;
}

export interface ConnectorHost {
  /** The socket a stdio connector serves on; `undefined` for one without ops. */
  readonly socket: string | undefined;
  /** Resolves with the exit code the host process should exit with. */
  readonly done: Promise<number>;
  stop(): Promise<void>;
}

/** Everything needed to start the connector's process once. */
interface Launch {
  manifest: ConnectorConfig;
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
}

function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues.map((i) => `  ${i.path === '' ? '' : `${i.path}: `}${i.message}`).join('\n');
}

export class ConnectorHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorHostError';
  }
}

/**
 * Reads the config and the manifest and renders the process's environment. Throws a
 * `ConnectorHostError` naming what is wrong; never logs a secret.
 */
export function prepareLaunch(
  opts: Pick<ConnectorHostOptions, 'configFile' | 'name' | 'env'>,
): Launch {
  const agent = loadAgentFile(opts.configFile);
  if (!agent.ok) {
    throw new ConnectorHostError(`invalid ${agent.file}:\n${formatIssues(agent.issues)}`);
  }
  const config = agent.config;
  const loaded = loadConnectors(config.connectorPaths, config.connectors);
  if (!loaded.ok) {
    const bad = loaded.files.filter((f) => !f.ok);
    throw new ConnectorHostError(
      `invalid connector manifests:\n${bad.map((f) => `${f.file}:\n${formatIssues(f.issues ?? [])}`).join('\n')}`,
    );
  }
  const manifest = (loaded.connectors ?? []).find((m) => m.name === opts.name);
  if (manifest === undefined) {
    throw new ConnectorHostError(`no connector named "${opts.name}" in ${config.file}`);
  }
  if (manifest.managed_by !== 'systemd') {
    throw new ConnectorHostError(
      `connector "${opts.name}" is spawned by the daemon; set managed_by: systemd in its manifest to run it in a unit`,
    );
  }
  const [command, ...args] = manifest.exec ?? [];
  if (command === undefined) {
    throw new ConnectorHostError(`connector "${opts.name}" has no exec`);
  }
  const secrets = createSecretsBackend(config.secrets, dirname(config.file), opts.env);
  let env: Record<string, string>;
  try {
    env = connectorChildEnv({
      manifest,
      secrets,
      baseEnv: getDefaultEnvironment(),
      socketPath: config.socket,
    });
  } catch (err) {
    throw new ConnectorHostError(
      `cannot prepare the environment of "${opts.name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { manifest, command, args, cwd: manifest.cwd, env };
}

/** Starts hosting; throws `ConnectorHostError` when the connector cannot be run at all. */
export async function startConnectorHost(opts: ConnectorHostOptions): Promise<ConnectorHost> {
  const first = prepareLaunch(opts);
  if (first.manifest.transport === 'stdio') {
    return serveSocket(first, opts);
  }
  return runOnce(first, opts);
}

function start(launch: Launch, stdio: 'inherit' | 'pipe'): ChildProcess {
  return spawn(launch.command, launch.args, {
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
    env: launch.env,
    stdio: stdio === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'inherit'],
  });
}

/** Resolves once the process has exited, with its code (128+signal when killed). */
function exitOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 128);
      return;
    }
    child.once('error', () => {
      resolve(127);
    });
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128 + (signalNumber(signal) ?? 0)));
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal as string];
}

async function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }
  const exited = exitOf(child);
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exited;
  clearTimeout(timer);
}

/** `transport: none`: one process for the life of the unit. */
function runOnce(launch: Launch, opts: ConnectorHostOptions): ConnectorHost {
  const grace = opts.killTimeoutMs ?? 5000;
  const child = start(launch, 'inherit');
  child.on('error', (err) => {
    opts.log(`connector-host: cannot start ${launch.command}: ${err.message}`);
  });
  opts.log(
    `connector-host: ${launch.manifest.name} started (pid ${String(child.pid ?? '?')}, no ops)`,
  );
  let stopping = false;
  const done = exitOf(child).then((code) => {
    if (!stopping) {
      opts.log(`connector-host: ${launch.manifest.name} exited with ${String(code)}`);
    }
    return stopping ? 0 : code === 0 ? 1 : code;
  });
  return {
    socket: undefined,
    done,
    stop: async () => {
      stopping = true;
      await terminate(child, grace);
    },
  };
}

/** `transport: stdio`: a fresh process per core connection, bridged to the socket. */
async function serveSocket(first: Launch, opts: ConnectorHostOptions): Promise<ConnectorHost> {
  const grace = opts.killTimeoutMs ?? 5000;
  const path = opts.socket ?? unitSocket(first.manifest);
  let current: { socket: Socket; child: ChildProcess } | undefined;
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const drop = async (session: { socket: Socket; child: ChildProcess }): Promise<void> => {
    session.socket.destroy();
    await terminate(session.child, grace);
  };

  const onConnection = (socket: Socket): void => {
    const previous = current;
    current = undefined;
    void (async () => {
      if (previous !== undefined) {
        opts.log('connector-host: a new connection replaces the previous one');
        await drop(previous);
      }
      let launch: Launch;
      try {
        launch = prepareLaunch(opts);
      } catch (err) {
        opts.log(`connector-host: ${err instanceof Error ? err.message : String(err)}`);
        socket.destroy();
        return;
      }
      if (socket.destroyed) {
        return;
      }
      const child = start(launch, 'pipe');
      const session = { socket, child };
      current = session;
      opts.log(
        `connector-host: ${launch.manifest.name} started for the core (pid ${String(child.pid ?? '?')})`,
      );
      child.on('error', (err) => {
        opts.log(`connector-host: cannot start ${launch.command}: ${err.message}`);
        socket.destroy();
      });
      child.stdin?.on('error', () => undefined);
      socket.on('error', () => undefined);
      if (child.stdin !== null) {
        socket.pipe(child.stdin);
      }
      child.stdout?.pipe(socket);
      socket.once('close', () => {
        if (current === session) {
          current = undefined;
        }
        void terminate(child, grace);
      });
      void exitOf(child).then((code) => {
        opts.log(`connector-host: ${launch.manifest.name} exited with ${String(code)}`);
        socket.end();
      });
    })();
  };

  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    // The core connects as another user in the same group.
    chmodSync(path, 0o660);
  } catch (err) {
    opts.log(
      `connector-host: cannot set the mode of ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  opts.log(`connector-host: ${first.manifest.name} serving its ops on ${path}`);
  server.on('error', (err) => {
    opts.log(`connector-host: socket error: ${err.message}`);
    finish(1);
  });

  return {
    socket: path,
    done,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        if (current !== undefined) {
          const session = current;
          current = undefined;
          void drop(session);
        }
      });
      rmSync(path, { force: true });
      finish(0);
    },
  };
}
