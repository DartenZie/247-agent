import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
  ACTIVE_STATUSES,
  ApiError,
  type RunRecord,
  type RunStatus,
  type TranscriptEntry,
} from '@247-agent/core';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';
import { eventLine, runLine, took, transcriptLines } from './format.js';

export const RUNS_USAGE = `usage: oa runs <ls|show <id>|logs <id>> [options]

ls          the newest runs, one per line: id, task, status, created, duration, error
show <id>   one run: its trigger event, timings, ledger rows and result or error
logs <id>   the run's agent transcript: prompt, messages, tool calls, permissions,
            usage, stop and result (other action kinds record none)

options for ls:
  --status <s>          queued, running, waiting, succeeded, failed or cancelled
  --task <name>         one task
  -n, --limit <n>       how many (default 20)
options for logs:
  -f, --follow          keep printing while the run is queued, running or waiting
  --after <id>          entries after this transcript entry id
common:
  --json                print the response as JSON (logs: one entry per line)
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

const STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
];

const isActive = (status: RunStatus): boolean =>
  (ACTIVE_STATUSES as readonly RunStatus[]).includes(status);

const POLL_MS = 1000;

function positiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`runs: ${flag} must be a positive integer`);
  }
  return n;
}

export async function runs(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      status: { type: 'string' },
      task: { type: 'string' },
      limit: { type: 'string', short: 'n', default: '20' },
      follow: { type: 'boolean', short: 'f', default: false },
      after: { type: 'string' },
      json: { type: 'boolean', default: false },
      socket: { type: 'string' },
    },
  });
  const [sub, id, ...extra] = positionals;
  if (extra.length > 0) {
    throw new UsageError('runs: too many arguments');
  }
  const api = client(values.socket);
  try {
    switch (sub) {
      case 'ls': {
        if (id !== undefined) {
          throw new UsageError('runs ls takes no argument');
        }
        if (values.status !== undefined && !STATUSES.includes(values.status as RunStatus)) {
          throw new UsageError(`runs: --status must be one of ${STATUSES.join(', ')}`);
        }
        const list = await api.listRuns({
          status: values.status as RunStatus | undefined,
          task: values.task,
          limit: positiveInt('--limit', values.limit),
        });
        if (values.json) {
          io.out(JSON.stringify({ runs: list }));
        } else if (list.length === 0) {
          io.out('no runs');
        } else {
          const width = Math.max(...list.map((r) => r.task.length));
          for (const r of list) {
            io.out(runLine(r, width));
          }
        }
        return EXIT.ok;
      }
      case 'show': {
        if (id === undefined) {
          throw new UsageError('runs show takes exactly one run id');
        }
        return await show(api, id, values.json, io);
      }
      case 'logs': {
        if (id === undefined) {
          throw new UsageError('runs logs takes exactly one run id');
        }
        const after = values.after === undefined ? 0 : positiveInt('--after', values.after);
        return await logs(api, id, { after, follow: values.follow, json: values.json }, io);
      }
      default:
        throw new UsageError('runs: usage is oa runs <ls|show <id>|logs <id>>');
    }
  } catch (err) {
    return reportApiError(err, io);
  }
}

type Api = ReturnType<typeof client>;

async function show(api: Api, id: string, json: boolean, io: Io): Promise<number> {
  const run: RunRecord = await api.getRun(id);
  const [event, ledger, transcript] = await Promise.all([
    api.getEvent(run.event_id).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) {
        return undefined;
      }
      throw err;
    }),
    api.getRunLedger(id),
    api.getTranscript(id, { limit: 1 }),
  ]);
  if (json) {
    io.out(
      JSON.stringify({
        run,
        event: event ?? null,
        ledger,
        has_transcript: transcript.entries.length > 0,
      }),
    );
    return run.status === 'failed' ? EXIT.failed : EXIT.ok;
  }
  const row = (k: string, v: string): void => {
    io.out(`${k.padEnd(11)} ${v}`);
  };
  row('run', run.id);
  row('task', run.task);
  row('status', run.status + (run.attempt > 1 ? `  (attempt ${String(run.attempt)})` : ''));
  row('event', event === undefined ? run.event_id : eventLine(event));
  if (event?.payload !== undefined && event.payload !== null) {
    row('payload', JSON.stringify(event.payload));
  }
  row('created', run.created_at);
  if (run.started_at !== null) {
    row('started', run.started_at);
  }
  if (run.finished_at !== null) {
    row('finished', `${run.finished_at}  (took ${took(run.started_at, run.finished_at)})`);
  }
  if (ledger.entries.length > 0) {
    row(
      'cost',
      `$${ledger.total_usd.toFixed(4)} in ${String(ledger.entries.length)} ${ledger.entries.length === 1 ? 'call' : 'calls'}`,
    );
    for (const e of ledger.entries) {
      row(
        '',
        `${e.ts}  ${e.provider}/${e.model}  in=${String(e.in_tok)} out=${String(e.out_tok)} cache_rd=${String(e.cache_read)}  $${e.usd.toFixed(4)} (${e.priced_by})`,
      );
    }
  }
  if (transcript.entries.length > 0) {
    row('transcript', `yes  (oa runs logs ${run.id})`);
  }
  if (run.error !== null) {
    row('error', run.error);
  }
  if (run.result !== null) {
    row('result', JSON.stringify(run.result));
  }
  return run.status === 'failed' ? EXIT.failed : EXIT.ok;
}

async function logs(
  api: Api,
  id: string,
  opts: { after: number; follow: boolean; json: boolean },
  io: Io,
): Promise<number> {
  let run: RunRecord = await api.getRun(id);
  let after = opts.after;
  let printed = 0;
  const print = (entries: TranscriptEntry[]): void => {
    for (const e of entries) {
      printed++;
      after = e.id;
      if (opts.json) {
        io.out(JSON.stringify(e));
      } else {
        for (const line of transcriptLines(e)) {
          io.out(line);
        }
      }
    }
  };
  for (;;) {
    let page: TranscriptEntry[];
    do {
      page = (await api.getTranscript(id, { after, limit: 1000 })).entries;
      print(page);
    } while (page.length === 1000);
    if (!opts.follow || !isActive(run.status)) {
      break;
    }
    await sleep(POLL_MS);
    run = await api.getRun(id);
  }
  if (printed === 0 && !opts.json) {
    io.out(
      `no transcript for ${run.id} (${run.task}, ${run.status}): only agent runs record one` +
        (run.error === null ? '' : `; error: ${run.error}`),
    );
  }
  return EXIT.ok;
}
