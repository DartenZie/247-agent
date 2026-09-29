import { parseArgs } from 'node:util';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';

export const METRICS_USAGE = `usage: oa metrics [options]

Prints GET /metrics: the daemon's Prometheus text exposition (runs, events, model calls
and cost, connectors, retention). Prometheus cannot scrape a Unix socket directly, so
write this to a node_exporter textfile collector on a timer, or put a small HTTP proxy
in front of the socket.

options:
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

export async function metrics(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { socket: { type: 'string' } },
  });
  if (positionals.length > 0) {
    throw new UsageError('metrics takes no argument');
  }
  const api = client(values.socket);
  try {
    const text = await api.metrics();
    for (const line of text.replace(/\n$/, '').split('\n')) {
      io.out(line);
    }
    return EXIT.ok;
  } catch (err) {
    return reportApiError(err, io);
  }
}
