import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import type { EventRecord } from '@247-agent/core';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';
import { eventLine } from './format.js';

export const EVENTS_USAGE = `usage: oa events <tail|show <id>> [options]

tail        the newest events in order, one per line; --follow keeps printing new ones
show <id>   one event with its payload

options for tail:
  --type <type|pattern>   only this type; * matches one segment (email.*, task.*.failed)
  -n, --limit <n>         how many to start with (default 20)
  -f, --follow            poll for new events until interrupted
common:
  --json                  print events as JSON (tail: one per line)
  --socket <path>         daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

const POLL_MS = 1000;

export async function events(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      type: { type: 'string' },
      limit: { type: 'string', short: 'n', default: '20' },
      follow: { type: 'boolean', short: 'f', default: false },
      json: { type: 'boolean', default: false },
      socket: { type: 'string' },
    },
  });
  const [sub, id, ...extra] = positionals;
  if (extra.length > 0) {
    throw new UsageError('events: too many arguments');
  }
  const api = client(values.socket);
  const print = (e: EventRecord): void => {
    io.out(values.json ? JSON.stringify(e) : eventLine(e));
  };
  try {
    switch (sub) {
      case 'tail': {
        if (id !== undefined) {
          throw new UsageError('events tail takes no argument');
        }
        const limit = Number(values.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new UsageError('events: --limit must be a positive integer');
        }
        const first = await api.listEvents({ type: values.type, limit });
        first.forEach(print);
        if (!values.follow) {
          if (first.length === 0 && !values.json) {
            io.out('no events');
          }
          return EXIT.ok;
        }
        // Nothing matched yet: start from the newest event of any type.
        let after = first.at(-1)?.seq ?? (await api.listEvents({ limit: 1 })).at(-1)?.seq ?? 0;
        for (;;) {
          await sleep(POLL_MS);
          const page = await api.listEvents({ type: values.type, after, limit: 1000 });
          page.forEach(print);
          after = page.at(-1)?.seq ?? after;
        }
      }
      case 'show': {
        if (id === undefined) {
          throw new UsageError('events show takes exactly one event id');
        }
        const e = await api.getEvent(id);
        if (values.json) {
          io.out(JSON.stringify(e));
        } else {
          io.out(eventLine(e));
          io.out(`payload: ${JSON.stringify(e.payload)}`);
        }
        return EXIT.ok;
      }
      default:
        throw new UsageError('events: usage is oa events <tail|show <id>>');
    }
  } catch (err) {
    return reportApiError(err, io);
  }
}
