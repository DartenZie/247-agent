import { describe, expect, it } from 'vitest';

import { parseTasks } from './config/load.js';
import type { TaskConfig } from './config/schema.js';
import { dryRun, parseStubs } from './dry-run.js';

function task(yaml: string): TaskConfig {
  const r = parseTasks(yaml, 'tasks.yaml');
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }
  const t = r.config.tasks[0];
  if (t === undefined) {
    throw new Error('no task');
  }
  return t;
}

const TRIAGE = task(`
tasks:
  - name: triage
    trigger:
      kind: event
      type: email.received
      filter: "payload.from != 'noreply@example.com'"
    action:
      kind: decide
      state: \${event.payload.subject}
      questions:
        urgent:
          type: noul
          instructions: Is this email urgent?
    emit:
      - type: email.urgent
        when: "result.answers.urgent.answer"
        payload:
          subject: \${event.payload.subject}
    state_updates:
      triage.last_subject: \${event.payload.subject}
`);

const MAIL = { type: 'email.received', payload: { from: 'ann@example.com', subject: 'Fire' } };

describe('dryRun', () => {
  it('runs the task with a stubbed model step and reports emits and state updates without applying them', async () => {
    const report = await dryRun({
      task: TRIAGE,
      event: MAIL,
      stubs: parseStubs({ results: { action: { answers: { urgent: { answer: 'yes' } } } } }),
    });
    expect(report).toEqual({
      ok: true,
      result: { answers: { urgent: { answer: 'yes' } } },
      emitted: [{ type: 'email.urgent', payload: { subject: 'Fire' } }],
      state_updates: [{ namespace: 'triage', key: 'last_subject', value: 'Fire' }],
    });
  });

  it('fails with a message naming a model or connector step that has no stub', async () => {
    const report = await dryRun({ task: TRIAGE, event: MAIL, stubs: parseStubs({}) });
    expect(report).toEqual({
      ok: false,
      error: 'action (decide) has no stub: add results."action" to the stub file',
    });
  });

  it('fails when the event does not pass the trigger, and says why', async () => {
    const report = await dryRun({
      task: TRIAGE,
      event: { type: 'email.received', payload: { from: 'noreply@example.com' } },
      stubs: parseStubs({ results: { action: {} } }),
    });
    expect(report).toEqual({
      ok: false,
      error:
        'the event does not trigger task "triage": filter payload.from != \'noreply@example.com\' is false',
    });
  });

  it('stubs connector and wait steps of a sequence by path, runs shell steps, and sees the stub state', async () => {
    const t = task(`
tasks:
  - name: notify
    trigger: { kind: manual }
    action:
      kind: sequence
      steps:
        - kind: shell
          cmd: ["echo", "\${event.payload.name}-\${state.app.version}"]
        - kind: connector
          connector: chat
          op: send
          args: { text: "\${steps[0]}" }
        - kind: wait
          for: { type: chat.reply }
    emit:
      - type: notify.done
        payload:
          sent: \${result.steps[1].id}
          reply: \${result.steps[2].payload.text}
`);
    const report = await dryRun({
      task: t,
      event: { payload: { name: 'web' } },
      stubs: parseStubs({
        state: { app: { version: '1.2' } },
        results: {
          'action.steps[1]': { id: 'm1' },
          'action.steps[2]': { type: 'chat.reply', payload: { text: 'ok' } },
        },
      }),
    });
    expect(report.ok).toBe(true);
    if (!report.ok) {
      return;
    }
    expect(report.result).toMatchObject({ steps: ['web-1.2', { id: 'm1' }, {}] });
    expect(report.emitted).toEqual([{ type: 'notify.done', payload: { sent: 'm1', reply: 'ok' } }]);
  });

  it('names the sequence step that has no stub', async () => {
    const t = task(`
tasks:
  - name: send
    trigger: { kind: manual }
    action:
      kind: sequence
      steps:
        - kind: shell
          cmd: ["true"]
        - kind: connector
          connector: chat
          op: send
          args: {}
`);
    const report = await dryRun({ task: t, stubs: parseStubs({}) });
    expect(report).toEqual({
      ok: false,
      error:
        'action.steps[1] (connector chat.send) has no stub: add results."action.steps[1]" to the stub file',
    });
  });

  it('rejects a stub for a path the task does not have', async () => {
    const report = await dryRun({
      task: TRIAGE,
      event: MAIL,
      stubs: parseStubs({ results: { action: {}, 'action.steps[0]': {} } }),
    });
    expect(report).toEqual({
      ok: false,
      error: 'the stub file has results for action.steps[0], which task "triage" has no step at',
    });
  });

  it('reports an emit rule that fails to render', async () => {
    const t = task(`
tasks:
  - name: fan
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["true"] }
    emit:
      - type: item.found
        each: \${event.payload.name}
`);
    const report = await dryRun({
      task: t,
      event: { payload: { name: 'x' } },
      stubs: parseStubs({}),
    });
    expect(report.ok).toBe(false);
    expect(report.ok ? '' : report.error).toMatch(
      /^emit\[0\] \(item\.found\): each did not render/,
    );
  });

  it('hands templates that name a secret a placeholder, never a credential', async () => {
    const t = task(`
tasks:
  - name: secret
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["echo", "\${secrets.api_token}"] }
`);
    const report = await dryRun({
      task: t,
      stubs: parseStubs({}),
      env: { PATH: process.env.PATH ?? '', OA_SECRET_API_TOKEN: 'real' },
    });
    expect(report).toMatchObject({ ok: true, result: '<secret api_token>' });
  });

  it('refuses a stub file that is not an object of results and state', () => {
    expect(() => parseStubs({ result: {} })).toThrow(/result/);
  });
});
