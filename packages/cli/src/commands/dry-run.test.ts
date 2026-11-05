import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../cli.js';
import type { Io } from '../io.js';

const TASKS = `tasks:
  - name: triage
    trigger: { kind: event, type: email.received }
    action:
      kind: llm
      model: claude-haiku-4-5
      input: "Classify: \${event.payload.subject}"
      output_schema: { type: object }
    emit:
      - type: email.classified
        payload: { label: "\${result.label}" }
    state_updates:
      mail.last: \${result.label}
`;

let dir: string;
let out: string[];
let err: string[];
const io: Io = {
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  readStdin: () => Promise.resolve(''),
};

function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-dry-run-'));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('oa dry-run', () => {
  it('prints the result, the events it would emit and the state it would write', async () => {
    const code = await main(
      [
        'dry-run',
        'triage',
        '--tasks',
        file('tasks.yaml', TASKS),
        '--event',
        file('event.json', '{"type": "email.received", "payload": {"subject": "Invoice"}}'),
        '--stubs',
        file('stubs.yaml', 'results:\n  action: { label: billing }\n'),
      ],
      io,
    );
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({
      result: { label: 'billing' },
      emitted: [{ type: 'email.classified', payload: { label: 'billing' } }],
      state_updates: [{ namespace: 'mail', key: 'last', value: 'billing' }],
    });
  });

  it('fails, naming the step, when a model step has no stub', async () => {
    const code = await main(
      [
        'dry-run',
        'triage',
        '--tasks',
        file('tasks.yaml', TASKS),
        '--event',
        file('event.yaml', 'type: email.received\npayload: { subject: x }\n'),
      ],
      io,
    );
    expect(code).toBe(1);
    expect(err).toEqual([
      'dry-run: action (llm) has no stub: add results."action" to the stub file',
    ]);
  });

  it('reports an unknown task and an invalid tasks file', async () => {
    expect(await main(['dry-run', 'nope', '--tasks', file('tasks.yaml', TASKS)], io)).toBe(1);
    expect(err).toEqual(['dry-run: no task "nope" in the tasks files']);
    err = [];
    expect(await main(['dry-run', 'x', '--tasks', file('bad.yaml', 'tasks: 3\n')], io)).toBe(1);
    expect(err[0]).toMatch(/bad\.yaml/);
  });

  it('exits 2 on an unreadable event file or an invalid stub file', async () => {
    const tasks = file('tasks.yaml', TASKS);
    expect(
      await main(['dry-run', 'triage', '--tasks', tasks, '--event', join(dir, 'none.json')], io),
    ).toBe(2);
    expect(err[0]).toMatch(/^dry-run: cannot read .*none\.json/);
    err = [];
    const stubs = file('stubs.yaml', 'result: {}\n');
    expect(await main(['dry-run', 'triage', '--tasks', tasks, '--stubs', stubs], io)).toBe(2);
    expect(err[0]).toMatch(/^dry-run: invalid stub file: .*result/);
    err = [];
    const typo = file('typo.yaml', 'type: email.received\npaylaod: {}\n');
    expect(await main(['dry-run', 'triage', '--tasks', tasks, '--event', typo], io)).toBe(2);
    expect(err[0]).toBe(
      `dry-run: ${typo}: unknown key "paylaod"; an event has type, source and payload`,
    );
  });

  it('needs a task name and --tasks', async () => {
    expect(await main(['dry-run', 'triage'], io)).toBe(2);
    expect(err[0]).toBe('dry-run: --tasks is required');
  });
});
