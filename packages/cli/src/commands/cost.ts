import { parseArgs } from 'node:util';

import { PRICED_BY, type CostGroup, type CostRow } from '@247-agent/core';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';

export const COST_USAGE = `usage: oa cost [options]

Sums the cost ledger (one row per model call) since a point in time. The priced_by
column counts each group's calls by how they were priced (table, provider, estimate,
unpriced); an unpriced call counts as $0 in usd.

options:
  --by <task|model|provider|day>   group rows (default: task)
  --since <duration|ISO>           window start, e.g. 7d, 24h or 2026-09-01 (default: 24h)
  --json                           print the response as JSON
  --socket <path>                  daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

const GROUPS: readonly CostGroup[] = ['task', 'model', 'provider', 'day'];

/** One source by name; a mix as `table:40,unpriced:1`, so a $0 row is never mistaken for a cheap one. */
function pricedBy(counts: CostRow['priced_by']): string {
  const used = PRICED_BY.filter((p) => counts[p] > 0);
  return used.length === 1
    ? (used[0] ?? '')
    : used.map((p) => `${p}:${String(counts[p])}`).join(',');
}

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
      `${values.by.padEnd(width)}  ${'calls'.padStart(6)}  ${'in_tok'.padStart(9)}  ${'out_tok'.padStart(9)}  ${'cache_rd'.padStart(9)}  ${'cache_wr'.padStart(9)}  ${'usd'.padStart(9)}  priced_by`,
    );
    let unpriced = 0;
    for (const row of r.rows) {
      unpriced += row.priced_by.unpriced;
      io.out(
        `${row.key.padEnd(width)}  ${String(row.calls).padStart(6)}  ${String(row.in_tok).padStart(9)}  ${String(row.out_tok).padStart(9)}  ${String(row.cache_read).padStart(9)}  ${String(row.cache_write).padStart(9)}  ${row.usd.toFixed(4).padStart(9)}  ${pricedBy(row.priced_by)}`,
      );
    }
    io.out(`total since ${r.since}: $${r.total_usd.toFixed(4)}`);
    if (unpriced > 0) {
      io.out(
        unpriced === 1
          ? '1 unpriced call counts as $0: the daemon could not price it'
          : `${String(unpriced)} unpriced calls count as $0: the daemon could not price them`,
      );
    }
    return EXIT.ok;
  } catch (err) {
    return reportApiError(err, io);
  }
}
