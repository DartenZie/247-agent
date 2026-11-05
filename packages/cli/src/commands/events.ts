import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import type { EventRecord, EventTasksBody, TaskMatch } from '@247-agent/core';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';
import { reconnecting, POLL_MS } from './follow.js';
import { eventLine } from './format.js';

export const EVENTS_USAGE = `usage: oa events <tail|show <id>> [options]

tail        the newest events in order, one per line; --follow keeps printing new ones
show <id>   one event with its payload and, per configured task, the run it started
            or why it started none: no match (own source, type, filter is false,
            filter error) or skipped (depth, paused, overlap, chain_runs)

options for tail:
  --type <type|pattern>   only this type; * matches one segment (email.*, task.*.failed)
  -n, --limit <n>         how many to start with (default 20)
  -f, --follow            poll for new events until interrupted, waiting for the
                          daemon when it restarts
common:
  --json                  print events as JSON (tail: one per line)
  --socket <path>         daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

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
        const call = reconnecting(io);
        let after =
          first.at(-1)?.seq ?? (await call(() => api.listEvents({ limit: 1 }))).at(-1)?.seq ?? 0;
        for (;;) {
          await sleep(POLL_MS);
          const page = await call(() => api.listEvents({ type: values.type, after, limit: 1000 }));
          page.forEach(print);
          after = page.at(-1)?.seq ?? after;
        }
      }
      case 'show': {
        if (id === undefined) {
          throw new UsageError('events show takes exactly one event id');
        }
        const [e, matches] = await Promise.all([api.getEvent(id), api.getEventTasks(id)]);
        if (values.json) {
          const { event_id: _id, ...rest } = matches;
          io.out(JSON.stringify({ event: e, ...rest }));
        } else {
          io.out(eventLine(e));
          io.out(`payload: ${JSON.stringify(e.payload)}`);
          taskLines(matches).forEach((l) => {
            io.out(l);
          });
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

const REASONS: Record<NonNullable<TaskMatch['reason']>, string> = {
  own_source: 'own source',
  type: 'type',
  filter: 'filter is false',
  filter_error: 'filter error',
  depth: 'depth',
  paused: 'paused',
  overlap: 'overlap',
  chain_runs: 'chain_runs',
  unknown: 'no run, reason unknown',
};

function matchText(m: TaskMatch): string {
  switch (m.outcome) {
    case 'started':
      return `started   ${m.run_id ?? ''}`;
    case 'pending':
      return 'pending   matches; not dispatched yet';
    case 'skipped':
    case 'no_match': {
      const reason = m.reason === null ? '' : REASONS[m.reason];
      const detail = m.detail === null ? '' : `: ${m.detail}`;
      return `${m.outcome === 'skipped' ? 'skipped ' : 'no match'}  ${reason}${detail}`;
    }
  }
}

/** `tasks:` then one line per task, and per run of a task no longer configured. */
function taskLines(m: EventTasksBody): string[] {
  const configured = new Set(m.tasks.map((t) => t.task));
  const gone = m.runs.filter((r) => !configured.has(r.task));
  const names = [...m.tasks.map((t) => t.task), ...gone.map((r) => r.task)];
  if (names.length === 0) {
    return ['tasks: none configured'];
  }
  const width = Math.max(...names.map((n) => n.length));
  return [
    'tasks:',
    ...m.tasks.map((t) => `  ${t.task.padEnd(width)}  ${matchText(t)}`),
    ...gone.map((r) => `  ${r.task.padEnd(width)}  started   ${r.id}  (task no longer configured)`),
  ];
}
