#!/usr/bin/env node
/**
 * `247-agent-core --config /etc/247-agent/agent.yaml` (ARCHITECTURE §12).
 * SIGTERM/SIGINT stop the daemon; SIGHUP reloads the tasks file. Logs are JSON lines on
 * stdout for journald.
 */
import { parseArgs } from 'node:util';

import { LOG_LEVELS } from './config/agent.js';
import { startDaemon, type Daemon } from './daemon.js';
import { findHome, homeEnv } from './home.js';
import { createLogger, type LogLevel } from './log.js';
import { VERSION } from './version.js';

const USAGE = `usage: 247-agent-core [--config <agent.yaml>] [--log-level <level>]

options:
  -c, --config <file>   agent config (default: /etc/247-agent/agent.yaml)
      --log-level <l>   debug | info | warn | error (default: log.level from the config)
  -h, --help
  -V, --version
`;

function isLogLevel(v: string): v is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(v);
}

async function main(argv: string[]): Promise<number> {
  let values: { config: string; 'log-level'?: string; help: boolean; version: boolean };
  try {
    values = parseArgs({
      args: argv,
      options: {
        config: { type: 'string', short: 'c', default: '/etc/247-agent/agent.yaml' },
        'log-level': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'V', default: false },
      },
    }).values;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const level = values['log-level'];
  if (level !== undefined && !isLogLevel(level)) {
    process.stderr.write(`unknown log level "${level}"\n${USAGE}`);
    return 2;
  }

  // Make the install self-referential before anything is spawned: connectors named in
  // manifests (`247-agent-connector-email`) and `node` resolve to this install's copies.
  const home = findHome(process.env, process.argv[1]);
  if (home !== undefined) {
    Object.assign(process.env, homeEnv(home, process.env));
  }

  let daemon: Daemon;
  try {
    daemon = await startDaemon({
      configFile: values.config,
      ...(level === undefined ? {} : { logLevel: level }),
    });
  } catch (err) {
    process.stderr.write(`247-agent-core: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const log = createLogger({ level: level ?? daemon.config.log.level });
  log.info('daemon.home', { version: VERSION, home: home ?? null });

  return new Promise<number>((resolve) => {
    const shutdown = (signal: string): void => {
      log.info('daemon.signal', { signal });
      daemon.stop().then(
        () => {
          resolve(0);
        },
        (err: unknown) => {
          log.error('daemon.stop_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          resolve(1);
        },
      );
    };
    process.once('SIGTERM', () => {
      shutdown('SIGTERM');
    });
    process.once('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.on('SIGHUP', () => {
      log.info('daemon.signal', { signal: 'SIGHUP' });
      daemon.reload();
    });
    const crash = (kind: string, err: unknown): void => {
      log.error('daemon.crashed', {
        kind,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      void daemon.stop().finally(() => {
        resolve(1);
      });
    };
    process.once('uncaughtException', (err) => {
      crash('uncaughtException', err);
    });
    process.once('unhandledRejection', (err) => {
      crash('unhandledRejection', err);
    });
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`247-agent-core: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
