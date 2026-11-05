import { parseArgs } from 'node:util';

import {
  dryRun as runDry,
  formatLoadResult,
  loadTasks,
  parseStubs,
  readDataFile,
  type DryRunEvent,
  type DryRunStubs,
} from '@247-agent/core';

import { EXIT, UsageError, type Io } from '../io.js';

export const DRY_RUN_USAGE = `usage: oa dry-run <task> --tasks <file|dir>... [--event <file>] [--stubs <file>]

Runs one task offline against a sample event, with its llm, decide, agent, connector and
wait steps answered from a stub file. Needs no daemon and no credentials, makes no model
or connector call and writes no ledger entry. shell steps run for real unless stubbed.
Prints the result, the events the run would emit and the state updates it would apply,
as JSON; none of them is published or written. A step with no stub fails the dry run.

options:
  --tasks <path>    tasks file or tasks.d directory; repeat for several
  --event <file>    the event, YAML or JSON: {type, source?, payload}. Required for an
                    event trigger; for a manual or cron task it is the run's input, as
                    with oa run --payload
  --stubs <file>    YAML or JSON: {results: {<step path>: <result>}, state: {<ns>: {<key>: <value>}}}
                    step paths are "action", or "action.steps[<k>]" in a sequence
`;

function eventOf(doc: unknown, file: string): DryRunEvent {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${file}: the event must be an object with type and payload`);
  }
  const e = doc as Record<string, unknown>;
  for (const key of ['type', 'source'] as const) {
    if (e[key] !== undefined && typeof e[key] !== 'string') {
      throw new Error(`${file}: ${key} must be a string`);
    }
  }
  return e;
}

export async function dryRun(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      tasks: { type: 'string', multiple: true },
      event: { type: 'string' },
      stubs: { type: 'string' },
    },
  });
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) {
    throw new UsageError('dry-run: usage is oa dry-run <task> --tasks <file>');
  }
  if (values.tasks === undefined) {
    throw new UsageError('dry-run: --tasks is required');
  }
  const loaded = loadTasks(values.tasks);
  if (!loaded.ok || loaded.config === undefined) {
    for (const f of loaded.files) {
      if (!f.ok) {
        for (const line of formatLoadResult(f)) {
          io.err(line);
        }
      }
    }
    return EXIT.failed;
  }
  const task = loaded.config.tasks.find((t) => t.name === name);
  if (task === undefined) {
    io.err(`dry-run: no task "${name}" in the tasks files`);
    return EXIT.failed;
  }
  let event: DryRunEvent | undefined;
  let stubs: DryRunStubs;
  try {
    event =
      values.event === undefined ? undefined : eventOf(readDataFile(values.event), values.event);
    stubs = parseStubs(values.stubs === undefined ? {} : readDataFile(values.stubs));
  } catch (err) {
    throw new UsageError(`dry-run: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const report = await runDry({ task, event, stubs });
    if (!report.ok) {
      io.err(`dry-run: ${report.error}`);
      return EXIT.failed;
    }
    const { ok: _ok, ...rest } = report;
    io.out(JSON.stringify(rest, null, 2));
    return EXIT.ok;
  } catch (err) {
    io.err(`dry-run: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.failed;
  }
}
