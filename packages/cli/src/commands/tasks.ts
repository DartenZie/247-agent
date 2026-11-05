import { parseArgs } from 'node:util';

import type { TaskEntry } from '@247-agent/core';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';

export const TASKS_USAGE = `usage: oa tasks <ls|pause <name>|resume <name>> [options]

ls              the configured tasks, one per line: name, trigger (cron, event, manual),
                active or paused since <time>, the cron schedule and next fire or the
                event types and filter, the last run and how many runs the task has
pause <name>    start no new run of the task, whatever triggers it, until it is resumed;
                oa run refuses it; runs already queued, running or waiting carry on
                (end them with oa runs cancel); survives a reload and a restart
resume <name>   start runs again for events from now on; skipped events stay skipped

options:
  --json                print the response as JSON
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

function taskLine(t: TaskEntry, width: number): string {
  const state = t.paused_at === null ? 'active' : `paused since ${t.paused_at}`;
  const fields: string[] = [];
  if (t.schedule !== null) {
    fields.push(`schedule=${JSON.stringify(t.schedule)} next=${t.next_fire ?? '-'}`);
  }
  if (t.types !== null) {
    const filter = t.filter === null ? '' : ` filter=${JSON.stringify(t.filter)}`;
    fields.push(`on=${t.types.join(',')}${filter}`);
  }
  const last = t.last_run;
  fields.push(
    last === null ? 'last=-' : `last=${last.status} ${last.finished_at ?? last.created_at}`,
  );
  fields.push(
    `runs=${String(t.runs.total)}` + (t.runs.failed > 0 ? ` failed=${String(t.runs.failed)}` : ''),
  );
  return [`${t.name.padEnd(width)}  ${t.trigger.padEnd(6)}  ${state}`, ...fields].join('  ');
}

export async function tasks(args: string[], io: Io): Promise<number> {
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
      case 'ls': {
        if (name !== undefined) {
          throw new UsageError('tasks ls takes no argument');
        }
        const list = await api.listTasks();
        if (values.json) {
          io.out(JSON.stringify({ tasks: list }));
        } else if (list.length === 0) {
          io.out('no tasks');
        } else {
          const width = Math.max(...list.map((t) => t.name.length));
          for (const t of list) {
            io.out(taskLine(t, width));
          }
        }
        return EXIT.ok;
      }
      case 'pause':
      case 'resume': {
        if (name === undefined || extra.length > 0) {
          throw new UsageError(`tasks ${sub} takes exactly one task name`);
        }
        const task = sub === 'pause' ? await api.pauseTask(name) : await api.resumeTask(name);
        io.out(values.json ? JSON.stringify(task) : taskLine(task, task.name.length));
        return EXIT.ok;
      }
      default:
        throw new UsageError('tasks: usage is oa tasks <ls|pause <name>|resume <name>>');
    }
  } catch (err) {
    return reportApiError(err, io);
  }
}
