import { parseArgs } from 'node:util';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';

export const CONNECTOR_USAGE = `usage: oa connector <list|restart <name>> [options]

list             the daemon's connectors with state, pid and restart count
restart <name>   kill and respawn one connector; it re-reads its secrets, so this is
                 how a rotated secret reaches a running connector (built-in pollers
                 re-read on every poll and need no restart)

options:
  --json                print the response as JSON
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

export async function connector(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      socket: { type: 'string' },
    },
  });
  const [sub, name, ...extra] = positionals;
  const api = client(values.socket);
  try {
    switch (sub) {
      case 'list': {
        if (name !== undefined) {
          throw new UsageError('connector list takes no argument');
        }
        const connectors = await api.listConnectors();
        if (values.json) {
          io.out(JSON.stringify({ connectors }));
        } else if (connectors.length === 0) {
          io.out('no connectors');
        } else {
          for (const c of connectors) {
            const kind =
              c.builtin === null ? `pid=${c.pid === null ? '-' : String(c.pid)}` : 'builtin';
            const error = c.error === null ? '' : ` error=${JSON.stringify(c.error)}`;
            io.out(`${c.name}\t${c.state}\t${kind}\trestarts=${String(c.restarts)}${error}`);
          }
        }
        return EXIT.ok;
      }
      case 'restart': {
        if (name === undefined || extra.length > 0) {
          throw new UsageError('connector restart takes exactly one connector name');
        }
        const status = await api.restartConnector(name);
        if (values.json) {
          io.out(JSON.stringify(status));
        } else {
          io.out(
            `${status.name}\t${status.state}\tpid=${status.pid === null ? '-' : String(status.pid)}` +
              (status.error === null ? '' : ` error=${JSON.stringify(status.error)}`),
          );
        }
        return status.state === 'up' ? EXIT.ok : EXIT.failed;
      }
      default:
        throw new UsageError('connector: usage is oa connector <list|restart <name>>');
    }
  } catch (err) {
    return reportApiError(err, io);
  }
}
