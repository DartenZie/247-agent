import { parseArgs } from 'node:util';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';

export const HEALTH_USAGE = `usage: oa health [options]

Prints GET /v1/health: ok, degraded or failing, then one line per check (dispatcher,
database, connectors). Exit 0 when the daemon is ok; 1 when it is degraded, failing or
cannot be reached.

options:
  --json                print the report as JSON
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

export async function health(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      socket: { type: 'string' },
    },
  });
  if (positionals.length > 0) {
    throw new UsageError('health takes no argument');
  }
  const api = client(values.socket);
  try {
    const h = await api.health();
    if (values.json) {
      io.out(JSON.stringify(h));
    } else {
      const { dispatcher, database, connectors } = h.checks;
      const error = (e: string | null): string => (e === null ? '' : ` error=${JSON.stringify(e)}`);
      io.out(
        `${h.status}\tpid=${String(h.pid)}\tuptime=${String(h.uptime_s)}s\ttasks=${String(h.tasks)}\truns=${String(h.runs.pending)} pending, ${String(h.runs.in_flight)} in flight`,
      );
      io.out(
        `dispatcher\t${dispatcher.status}${dispatcher.failing_since === null ? '' : ` since=${dispatcher.failing_since}`}${error(dispatcher.error)}`,
      );
      io.out(`database\t${database.status}${error(database.error)}`);
      io.out(
        `connectors\t${connectors.status}\tup=${String(connectors.up)}/${String(connectors.total)}${connectors.down.length === 0 ? '' : ` down=${connectors.down.join(',')}`}`,
      );
    }
    return h.status === 'ok' ? EXIT.ok : EXIT.failed;
  } catch (err) {
    return reportApiError(err, io);
  }
}
