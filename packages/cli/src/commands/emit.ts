import { parseArgs } from 'node:util';

import type { JsonValue } from '@247-agent/core';

import { client, EXIT, readJson, reportApiError, UsageError, type Io } from '../io.js';

export const EMIT_USAGE = `usage: oa emit <type> [payload.json|-] [options]

Injects an event into the daemon as if a connector had emitted it.

options:
  --source <name>       event source (default: manual)
  --dedup-key <key>     drop the event if one with this key was already published
  --parent <event_id>   parent event; inherits its correlation id and depth + 1
  --correlation <id>    correlation id (ignored when --parent has one)
  --json                print the response as JSON
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

export async function emit(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      source: { type: 'string', default: 'manual' },
      'dedup-key': { type: 'string' },
      parent: { type: 'string' },
      correlation: { type: 'string' },
      json: { type: 'boolean', default: false },
      socket: { type: 'string' },
    },
  });
  const [type, payloadSource, ...extra] = positionals;
  if (type === undefined || extra.length > 0) {
    throw new UsageError('emit: usage is oa emit <type> [payload.json|-]');
  }
  const payload =
    payloadSource === undefined ? null : ((await readJson(payloadSource, io)) as JsonValue);

  try {
    const result = await client(values.socket).emit({
      type,
      source: values.source,
      payload,
      dedup_key: values['dedup-key'],
      parent_id: values.parent,
      correlation_id: values.correlation,
    });
    if (values.json) {
      io.out(JSON.stringify(result));
    } else if (result.status === 'inserted') {
      const e = result.event;
      io.out(`inserted ${e.id} type=${e.type} correlation=${e.correlation_id}`);
    } else {
      io.out(`duplicate dedup_key=${result.dedup_key}`);
    }
    return EXIT.ok;
  } catch (err) {
    return reportApiError(err, io);
  }
}
