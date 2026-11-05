import { parseArgs } from 'node:util';

import type { JsonValue } from '@247-agent/core';

import { client, EXIT, readJson, reportApiError, UsageError, type Io } from '../io.js';

export const EMIT_USAGE = `usage: oa emit <type> [payload.json|-] [options]

Injects an event into the daemon as if a connector had emitted it. Warns on stderr when
no task would start a run for it and no waiting run waits for it.

options:
  --source <name>       event source (default: manual)
  --dedup-key <key>     drop the event if one with this key was already published
  --parent <event_id>   parent event; depth + 1, and its correlation id by default
  --correlation <id>    correlation id; wins over the parent's
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
    }
    if (result.status === 'duplicate') {
      if (!values.json) {
        io.out(`duplicate dedup_key=${result.dedup_key}`);
      }
      return EXIT.ok;
    }
    const e = result.event;
    if (!values.json) {
      io.out(`inserted ${e.id} type=${e.type} correlation=${e.correlation_id}`);
    }
    const starts = result.tasks.some((t) => t.outcome === 'pending' || t.outcome === 'started');
    if (!starts && result.waiting_runs.length === 0) {
      io.err(
        `warning: no task and no waiting run matches ${e.type}; oa events show ${e.id} says why`,
      );
    }
    return EXIT.ok;
  } catch (err) {
    return reportApiError(err, io);
  }
}
