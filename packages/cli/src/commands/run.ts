import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
  ACTIVE_STATUSES,
  type JsonValue,
  type RunRecord,
  type RunStatus,
} from '@online-agent/core';

import { client, EXIT, readJson, reportApiError, UsageError, type Io } from '../io.js';

export const RUN_USAGE = `usage: oa run <task> [options]

Queues a run of <task> whatever its trigger kind; filters and cron overlap do not apply.

options:
  --event <file|->      JSON {"type": "...", "payload": ...} the action sees as its
                        trigger event (default type: manual.input)
  --type <event.type>   sets or overrides the event type
  --correlation <id>    correlation id to thread this run under
  --wait                block until the run finishes; exit 1 if it failed
  --json                print the response as JSON
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/online-agent/core.sock)
`;

interface EventInput {
  type?: string | undefined;
  payload?: JsonValue | undefined;
}

function eventFromFile(doc: unknown, source: string): EventInput {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UsageError(`${source}: expected an object {"type": ..., "payload": ...}`);
  }
  const o = doc as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'type' && key !== 'payload') {
      throw new UsageError(
        `${source}: unknown key "${key}" (only "type" and "payload" are allowed)`,
      );
    }
  }
  if (o.type !== undefined && typeof o.type !== 'string') {
    throw new UsageError(`${source}: "type" must be a string`);
  }
  return { type: o.type, payload: o.payload as JsonValue | undefined };
}

const isActive = (status: RunStatus): boolean =>
  (ACTIVE_STATUSES as readonly RunStatus[]).includes(status);

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      event: { type: 'string' },
      type: { type: 'string' },
      correlation: { type: 'string' },
      wait: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      socket: { type: 'string' },
    },
  });
  const [task, ...extra] = positionals;
  if (task === undefined || extra.length > 0) {
    throw new UsageError('run: exactly one task name is required');
  }
  const input: EventInput =
    values.event === undefined ? {} : eventFromFile(await readJson(values.event, io), values.event);
  if (values.type !== undefined) {
    input.type = values.type;
  }

  const api = client(values.socket);
  try {
    const { event_id, run: queued } = await api.run(task, {
      type: input.type,
      payload: input.payload,
      correlation_id: values.correlation,
    });
    let final: RunRecord = queued;
    if (values.wait) {
      while (isActive(final.status)) {
        await sleep(250);
        final = await api.getRun(queued.id);
      }
    }
    if (values.json) {
      io.out(JSON.stringify({ event_id, run: final }));
    } else if (!values.wait) {
      io.out(`queued ${final.id} for ${task} (event ${event_id})`);
    } else if (final.status === 'succeeded') {
      io.out(`succeeded ${final.id} for ${task}`);
      io.out(JSON.stringify(final.result));
    } else {
      io.out(`${final.status} ${final.id} for ${task}: ${final.error ?? 'no error recorded'}`);
    }
    return values.wait && final.status !== 'succeeded' ? EXIT.failed : EXIT.ok;
  } catch (err) {
    return reportApiError(err, io);
  }
}
