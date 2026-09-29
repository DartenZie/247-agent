import { VERSION } from '@247-agent/core';

import { connector, CONNECTOR_USAGE } from './commands/connector.js';
import { cost, COST_USAGE } from './commands/cost.js';
import { emit, EMIT_USAGE } from './commands/emit.js';
import { events, EVENTS_USAGE } from './commands/events.js';
import { metrics, METRICS_USAGE } from './commands/metrics.js';
import { reload, RELOAD_USAGE } from './commands/reload.js';
import { run, RUN_USAGE } from './commands/run.js';
import { runs, RUNS_USAGE } from './commands/runs.js';
import { validate, VALIDATE_USAGE } from './commands/validate.js';
import { EXIT, processIo, UsageError, type Io } from './io.js';

export const USAGE = `usage: oa <command> [args]

commands:
  validate <file>...                 validate tasks files / agent.yaml against the schema
  run <task> [--event f.json]        queue a run of a task by hand (--wait to block)
  emit <type> [payload.json|-]       inject an event
  runs ls|show <id>|logs <id>        list runs / one run with its cost / its agent transcript
  events tail|show <id>              the newest events (--type, --follow) / one event
  connector list|restart <name>      show connectors / respawn one (re-reads its secrets)
  cost [--by task|model|provider|day] [--since 7d]   sum the model-call ledger
  reload                             re-read agent.yaml, manifests and tasks files (like SIGHUP)
  metrics                            print the daemon's Prometheus metrics
  help [command]
  version                            print the version

The daemon socket is --socket, else $OA_CORE_SOCKET, else /run/247-agent/core.sock.
`;

const COMMAND_USAGE: Record<string, string> = {
  validate: VALIDATE_USAGE,
  run: RUN_USAGE,
  emit: EMIT_USAGE,
  runs: RUNS_USAGE,
  events: EVENTS_USAGE,
  connector: CONNECTOR_USAGE,
  cost: COST_USAGE,
  reload: RELOAD_USAGE,
  metrics: METRICS_USAGE,
};

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'validate':
        return validate(rest, io);
      case 'run':
        return await run(rest, io);
      case 'emit':
        return await emit(rest, io);
      case 'runs':
        return await runs(rest, io);
      case 'events':
        return await events(rest, io);
      case 'connector':
        return await connector(rest, io);
      case 'cost':
        return await cost(rest, io);
      case 'reload':
        return await reload(rest, io);
      case 'metrics':
        return await metrics(rest, io);
      case 'version':
      case '--version':
      case '-V':
        io.out(VERSION);
        return EXIT.ok;
      case undefined:
      case 'help':
      case '--help':
      case '-h': {
        const topic = rest[0];
        io.out((topic === undefined ? USAGE : COMMAND_USAGE[topic]) ?? USAGE);
        return command === undefined ? EXIT.usage : EXIT.ok;
      }
      default:
        io.err(`unknown command "${command}"`);
        io.err(USAGE);
        return EXIT.usage;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(err.message);
      io.err(command === undefined ? USAGE : (COMMAND_USAGE[command] ?? USAGE));
      return EXIT.usage;
    }
    // parseArgs rejects unknown flags with a coded TypeError.
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')
    ) {
      io.err(err.message);
      io.err(command === undefined ? USAGE : (COMMAND_USAGE[command] ?? USAGE));
      return EXIT.usage;
    }
    throw err;
  }
}
