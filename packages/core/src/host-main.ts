#!/usr/bin/env node
/**
 * `247-agent-connector-host [--config <agent.yaml>] [--socket <path>] <name>`: runs one
 * `managed_by: systemd` connector in its own `247-agent-connector@<name>` unit
 * (ARCHITECTURE §6, `connectors/host.ts`). Logs are JSON lines on stderr for journald,
 * like the daemon's; the connector's own stderr goes there too. SIGTERM/SIGINT stop the connector and exit.
 */
import { parseArgs } from 'node:util';

import { ConnectorHostError, startConnectorHost } from './connectors/host.js';
import { findHome, homeEnv } from './home.js';
import { createLogger } from './log.js';
import { VERSION } from './version.js';

const USAGE = `usage: 247-agent-connector-host [--config <agent.yaml>] [--socket <path>] <connector>

Runs one connector whose manifest says managed_by: systemd, as the
247-agent-connector@<connector> unit does.

options:
  -c, --config <file>   agent config (default: /etc/247-agent/agent.yaml)
      --socket <path>   where a connector with ops listens (default: the manifest's
                        socket, or /run/247-agent-connector/<connector>/mcp.sock); the
                        daemon only ever connects to the manifest's socket
  -h, --help
  -V, --version
`;

async function main(argv: string[]): Promise<number> {
  let parsed: {
    values: { config: string; socket?: string; help: boolean; version: boolean };
    positionals: string[];
  };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c', default: '/etc/247-agent/agent.yaml' },
        socket: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'V', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) {
    process.stderr.write(`name exactly one connector\n${USAGE}`);
    return 2;
  }

  // As in the daemon: bundled connectors (`247-agent-connector-email`) and `node` resolve
  // to this install's copies.
  const home = findHome(process.env, process.argv[1]);
  if (home !== undefined) {
    Object.assign(process.env, homeEnv(home, process.env));
  }

  const log = createLogger({
    base: { connector: name },
    sink: (line) => {
      process.stderr.write(line + '\n');
    },
  });
  let host;
  try {
    host = await startConnectorHost({
      configFile: values.config,
      name,
      env: process.env,
      socket: values.socket,
      log,
    });
  } catch (err) {
    log.error('connector_host.failed', { error: err instanceof Error ? err.message : String(err) });
    return err instanceof ConnectorHostError ? 1 : 70;
  }
  const running = host;
  const shutdown = (): void => {
    void running.stop();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return running.done;
}

process.exitCode = await main(process.argv.slice(2));
