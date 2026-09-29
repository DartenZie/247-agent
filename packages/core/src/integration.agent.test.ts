/**
 * An `agent` task end to end on a real daemon: the fake ACP agent (a real child process
 * speaking the Agent Client Protocol over stdio) runs one session per run in a workspace
 * under `work_dir`, its permission requests go through the task's policy, its reported
 * cost lands in the ledger, and RESULT.json drives the routing: `done` runs the post gates
 * and emits `site.change_ready`, `blocked` emits `site.change_blocked` and a deterministic
 * task replies through the fake chat connector, a refusal fails the run and reaches `notify`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient } from './api/client.js';
import { startDaemon, type Daemon } from './daemon.js';
import { createLogger } from './log.js';

const FIXTURES = new URL('../test/fixtures/', import.meta.url).pathname;

const AGENT = `
db: state.db
socket: core.sock
tasks: tasks.yaml
log: { level: debug }
secrets: { backend: file, path: secrets.yaml }
defaults:
  retry: { attempts: 1 }
  agent: { connector: coder, max_tool_calls: 10, budget: { max_usd: 1 }, work_dir: work }
budgets: { daily_usd: 5 }
connectors:
  - name: coder
    exec: [node, ${FIXTURES}fake-acp.ts]
    transport: acp
    env: { FAKE_MODEL_KEY: "\${secrets.model_key}" }
  - name: chat
    exec: [node, ${FIXTURES}fake-chat.ts]
    emits: [chat.reply]
    ops: [send]
    config: { token: "\${secrets.chat_token}" }
`;

const TASKS = `
tasks:
  - name: change_site
    trigger: { kind: manual }
    timeout: 20s
    action:
      kind: agent
      model: claude-sonnet-5
      workspace: { kind: temp }
      tools: [read, edit, execute]
      bash_allow: ["npm run build"]
      prompt: |
        Apply this request to the site.
        <email>
        \${event.payload.body}
        </email>
      result: { path: RESULT.json, schema: schemas/site_change.json }
      post:
        - shell: [sh, -c, 'test -f data/events.yaml && echo gated > gate.txt']
        - shell: [sh, -c, 'echo "\${result.summary}" > summary.txt']
    emit:
      - type: site.change_ready
        when: "result.status == 'done'"
        payload: { summary: "\${result.summary}", worktree: "\${run.workspace}" }
      - type: site.change_blocked
        when: "result.status == 'blocked'"
        payload: { summary: "\${result.summary}", missing: "\${result.missing}" }

  - name: reply_blocked
    trigger: { kind: event, type: site.change_blocked }
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "Cannot do it yet: \${event.payload.summary} (missing: \${join(', ', event.payload.missing)})" }

  - name: notify
    trigger: { kind: event, type_any: ["task.*.failed", budget.exceeded] }
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "[247-agent] \${event.type}: \${event.payload.error}" }
`;

const SCHEMA = JSON.stringify({
  type: 'object',
  required: ['status', 'summary'],
  properties: { files_changed: { type: 'array', items: { type: 'string' } } },
});

let dir: string;
let daemon: Daemon;
let api: ApiClient;
let lines: Record<string, unknown>[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oa-ia-'));
  writeFileSync(join(dir, 'agent.yaml'), AGENT);
  writeFileSync(join(dir, 'tasks.yaml'), TASKS);
  writeFileSync(join(dir, 'secrets.yaml'), 'model_key: "sk-model-not-real"\nchat_token: "tok"\n', {
    mode: 0o600,
  });
  mkdirSync(join(dir, 'schemas'));
  writeFileSync(join(dir, 'schemas', 'site_change.json'), SCHEMA);
  lines = [];
  daemon = await startDaemon({
    configFile: join(dir, 'agent.yaml'),
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
  });
  api = new ApiClient({ socketPath: daemon.config.socket });
  await until(() => daemon.core.supervisor?.status().every((s) => s.state === 'up') ?? false);
});

afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function until(pred: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) {
      throw new Error('timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const settled = async (id: string) => {
  await until(async () => ['succeeded', 'failed'].includes((await api.getRun(id)).status));
  await daemon.core.executor.idle();
  return api.getRun(id);
};

describe('agent task on the fake ACP connector', () => {
  it('done: edits in the workspace under the policy, runs the gates, ledgers the cost, emits change_ready', async () => {
    const { run } = await api.run('change_site', {
      payload: {
        body: '[[edit: data/events.yaml]] [[run: npm run build]] [[cost: 0.12]] [[result: {"status":"done","summary":"added the spring event","files_changed":["data/events.yaml"]}]]',
      },
    });
    const done = await settled(run.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: {
        status: 'done',
        summary: 'added the spring event',
        files_changed: ['data/events.yaml'],
      },
    });
    const ws = join(dir, 'work', run.id);
    expect(readFileSync(join(ws, 'data/events.yaml'), 'utf8')).toBe('edited by fake-acp\n');
    expect(readFileSync(join(ws, 'gate.txt'), 'utf8')).toBe('gated\n');
    expect(readFileSync(join(ws, 'summary.txt'), 'utf8')).toBe('added the spring event\n');

    const events = daemon.core.store.events.listAfter(0, 100);
    expect(events.map((e) => e.type)).toEqual([
      'manual.run',
      'task.change_site.succeeded',
      'site.change_ready',
    ]);
    expect(events[2]?.payload).toEqual({ summary: 'added the spring event', worktree: ws });

    const cost = await api.cost({ by: 'provider' });
    expect(cost.rows).toEqual([
      expect.objectContaining({ key: 'coder', calls: 1, in_tok: 1000, out_tok: 200, usd: 0.12 }),
    ]);
    expect(lines.filter((l) => l.msg === 'agent.permission')).toMatchObject([
      { allowed: true, tool_kind: 'execute' },
      { allowed: true, tool_kind: 'edit' },
    ]);
    expect(lines.find((l) => l.msg === 'agent.turn')).toMatchObject({
      provider: 'coder',
      model: 'claude-sonnet-5',
      priced_by: 'provider',
    });
    expect(JSON.stringify(lines)).not.toContain('sk-model-not-real');

    // A permission request is answered as it arrives while `tool_call` updates queue behind
    // the runner's loop, so the decision may precede or follow the call it answers.
    const { entries } = await api.getTranscript(run.id);
    const kinds = entries.map((e) => e.kind);
    expect(kinds.slice(0, 2)).toEqual(['prompt', 'text']);
    expect(kinds.slice(-4)).toEqual(['text', 'usage', 'stop', 'result']);
    expect([...kinds.slice(2, -4)].sort()).toEqual(
      [
        'permission',
        'tool_call',
        'tool_call_update',
        'permission',
        'tool_call',
        'tool_call_update',
      ].sort(),
    );
    const byKind = (kind: string) => entries.filter((e) => e.kind === kind);
    expect(entries[0]?.text).toContain('Apply this request to the site.');
    expect(entries[1]?.text).toBe('Working on it. ');
    expect(byKind('permission').map((e) => e.data)).toMatchObject([
      { tool_kind: 'execute', allowed: true },
      { tool_kind: 'edit', allowed: true },
    ]);
    expect(byKind('tool_call').map((e) => e.data)).toMatchObject([
      { tool_kind: 'execute', command: 'npm run build' },
      { tool_kind: 'edit', locations: [join(ws, 'data/events.yaml')] },
    ]);
    expect(byKind('tool_call_update').map((e) => e.data)).toMatchObject([
      { status: 'completed' },
      { status: 'completed' },
    ]);
    expect(byKind('usage')[0]?.data).toEqual({ used: 1200, size: 200_000, cost_usd: 0.12 });
    expect(byKind('stop')[0]?.data).toEqual({
      stop_reason: 'end_turn',
      input_tokens: 1000,
      output_tokens: 200,
    });
    expect(byKind('result')[0]?.data).toMatchObject({ status: 'done' });
    expect(entries.every((e) => e.run_id === run.id && e.turn === 1)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('sk-model-not-real');
  }, 30_000);

  it('blocked: skips the gates, still succeeds, and the reply task tells the sender what is missing', async () => {
    const { run } = await api.run('change_site', {
      payload: {
        body: '[[result: {"status":"blocked","summary":"no date for the event","missing":["date","venue"]}]]',
      },
    });
    const done = await settled(run.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: { status: 'blocked', summary: 'no date for the event', missing: ['date', 'venue'] },
    });
    await until(
      async () => (await api.listRuns({ task: 'reply_blocked', status: 'succeeded' })).length === 1,
    );
    expect(existsSync(join(dir, 'work', run.id, 'gate.txt'))).toBe(false);
    expect((await api.getState('chat', 'sent'))?.value).toEqual([
      'Cannot do it yet: no date for the event (missing: date, venue)',
    ]);
    expect(daemon.core.store.events.listAfter(0, 100).map((e) => e.type)).toEqual([
      'manual.run',
      'task.change_site.succeeded',
      'site.change_blocked',
      'task.reply_blocked.succeeded',
    ]);
  }, 30_000);

  it('refusal and a refused command fail the run, remove the workspace and reach notify', async () => {
    const { run } = await api.run('change_site', {
      payload: { body: '[[run: rm -rf /]] [[refuse]]' },
    });
    const failed = await settled(run.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'the agent refused the request' });
    expect(existsSync(join(dir, 'work', run.id))).toBe(false);
    expect(lines.filter((l) => l.msg === 'agent.permission')).toMatchObject([
      { allowed: false, reason: expect.stringMatching(/bash_allow/) as string },
    ]);
    await until(
      async () => (await api.listRuns({ task: 'notify', status: 'succeeded' })).length === 1,
    );
    expect((await api.getState('chat', 'sent'))?.value).toEqual([
      '[247-agent] task.change_site.failed: the agent refused the request',
    ]);
  }, 30_000);
});
