import { parseArgs } from 'node:util';

import type { CostGroup } from '@247-agent/core';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';

export const COST_USAGE = `usage: oa cost [options]

Sums the cost ledger (one row per model call) since a point in time.

options:
  --by <task|model|provider|day>   group rows (default: task)
  --since <duration|ISO>           window start, e.g. 7d, 24h or 2026-09-01 (default: 24h)
  --json                           print the response as JSON
  --socket <path>                  daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

const GROUPS: readonly CostGroup[] = ['task', 'model', 'provider', 'day'];

function isGroup(v: string): v is CostGroup {
  return (GROUPS as readonly string[]).includes(v);
}

export async function cost(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      by: { type: 'string', default: 'task' },
      since: { type: 'string', default: '24h' },
      json: { type: 'boolean', default: false },
      socket: { type: 'string' },
    },
  });
  if (!isGroup(values.by)) {
    throw new UsageError(`cost: --by must be one of ${GROUPS.join(', ')}`);
  }
  const api = client(values.socket);
  try {
    const r = await api.cost({ since: values.since, by: values.by });
    if (values.json) {
      io.out(JSON.stringify(r));
      return EXIT.ok;
    }
    if (r.rows.length === 0) {
      io.out(`no model calls since ${r.since}`);
      return EXIT.ok;
    }
    const width = Math.max(values.by.length, ...r.rows.map((row) => row.key.length));
    io.out(
      `${values.by.padEnd(width)}  ${'calls'.padStart(6)}  ${'in_tok'.padStart(9)}  ${'out_tok'.padStart(9)}  ${'cache_rd'.padStart(9)}  ${'usd'.padStart(9)}`,
    );
    for (const row of r.rows) {
      io.out(
        `${row.key.padEnd(width)}  ${String(row.calls).padStart(6)}  ${String(row.in_tok).padStart(9)}  ${String(row.out_tok).padStart(9)}  ${String(row.cache_read).padStart(9)}  ${row.usd.toFixed(4).padStart(9)}`,
      );
    }
    io.out(`total since ${r.since}: $${r.total_usd.toFixed(4)}`);
    return EXIT.ok;
  } catch (err) {
    return reportApiError(err, io);
  }
}
