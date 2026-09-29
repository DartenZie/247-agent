import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../log.js';
import { AcpAgent, normalisePermission, normaliseUpdate } from './acp.js';
import type { AgentSession, AgentStop, AgentUpdate } from './acp-types.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url).pathname;

let dir: string;
let lines: Record<string, unknown>[];
let agent: AcpAgent | undefined;

const log = () =>
  createLogger({
    level: 'debug',
    sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });

async function spawnFake(): Promise<AcpAgent> {
  agent = await AcpAgent.spawn({
    exec: ['node', `${FIXTURES}fake-acp.ts`],
    env: { PATH: process.env.PATH ?? '' },
    log: log(),
  });
  return agent;
}

/** Drains a turn into its updates and stop. */
async function drain(
  session: AgentSession,
  text: string,
  onUpdate?: (u: AgentUpdate) => Promise<void> | void,
): Promise<{ updates: AgentUpdate[]; stop: AgentStop }> {
  const updates: AgentUpdate[] = [];
  const gen = session.prompt(text);
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      return { updates, stop: next.value };
    }
    updates.push(next.value);
    await onUpdate?.(next.value);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-acp-'));
  lines = [];
});

afterEach(async () => {
  if (agent !== undefined) {
    agent.kill('SIGTERM');
    await agent.exited;
    agent = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('AcpAgent', () => {
  it('initialises, opens a session in the cwd, streams a turn and routes permission requests', async () => {
    const a = await spawnFake();
    expect(a.info).toEqual({ name: 'fake-acp', version: '0.1.0' });
    expect(a.pid).toEqual(expect.any(Number));
    const asked: string[] = [];
    const session = await a.openSession({
      cwd: dir,
      signal: new AbortController().signal,
      log: log(),
      onPermission: (req) => {
        asked.push(`${req.toolCall.toolKind}:${req.toolCall.command ?? req.toolCall.title}`);
        return req.toolCall.command === 'npm run build' ? 'yes' : 'no';
      },
    });
    expect(session.sessionId).toMatch(/^sess_/);
    const { updates, stop } = await drain(
      session,
      '[[run: npm run build]] [[edit: notes/a.txt]] [[cost: 0.25]] [[result: {"status":"done","summary":"ok"}]]',
    );
    expect(stop).toEqual({ stopReason: 'end_turn', usage: { input: 1000, output: 200 } });
    expect(asked).toEqual(['execute:npm run build', 'edit:Edit notes/a.txt']);
    expect(updates).toEqual([
      { kind: 'text', text: 'Working on it. ', messageId: null },
      expect.objectContaining({
        kind: 'tool_call',
        toolKind: 'execute',
        command: 'npm run build',
        status: 'pending',
      }),
      expect.objectContaining({ kind: 'tool_call_update', status: 'completed' }),
      expect.objectContaining({
        kind: 'tool_call',
        toolKind: 'edit',
        locations: [join(dir, 'notes/a.txt')],
      }),
      expect.objectContaining({ kind: 'tool_call_update', status: 'failed' }),
      { kind: 'text', text: 'Done.', messageId: null },
      { kind: 'usage', used: 1200, size: 200_000, costUsd: 0.25 },
    ]);
    expect(existsSync(join(dir, 'notes/a.txt'))).toBe(false); // the edit was refused
    expect(JSON.parse(readFileSync(join(dir, 'RESULT.json'), 'utf8'))).toEqual({
      status: 'done',
      summary: 'ok',
    });

    // A second turn on the same session; cost is cumulative on the agent's side.
    const again = await drain(session, '[[no-usage]]');
    expect(again.stop).toEqual({ stopReason: 'end_turn', usage: undefined });
    expect(again.updates.at(-1)).toEqual({
      kind: 'usage',
      used: 1200,
      size: 200_000,
      costUsd: 0.26,
    });
    session.close();
    expect(lines.filter((l) => l.msg === 'connector.output').map((l) => l.line)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^fake-acp session sess_/)]),
    );
  });

  it('reports the session config options and sets them over session/set_config_option', async () => {
    const a = await spawnFake();
    const session = await a.openSession({
      cwd: dir,
      signal: new AbortController().signal,
      log: log(),
      onPermission: () => 'no',
    });
    expect(session.configOptions).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'default',
        values: ['default', 'claude-sonnet-5', 'claude-opus-5'],
      },
      expect.objectContaining({ id: 'effort', currentValue: 'medium', values: ['low', 'medium'] }),
    ]);
    const after = await session.setConfigOption('model', 'claude-opus-5');
    expect(after[1]).toMatchObject({ id: 'effort', values: ['low', 'medium', 'high'] });
    await session.setConfigOption('effort', 'high');
    expect(session.configOptions.map((o) => o.currentValue)).toEqual(['claude-opus-5', 'high']);
    await expect(session.setConfigOption('effort', 'max')).rejects.toThrow();
    await drain(session, '[[config]]');
    expect(JSON.parse(readFileSync(join(dir, 'CONFIG.json'), 'utf8'))).toEqual({
      model: 'claude-opus-5',
      effort: 'high',
    });
    session.close();
  });

  it('cancels a running turn and answers pending permission requests as cancelled after the signal aborts', async () => {
    const a = await spawnFake();
    const controller = new AbortController();
    const session = await a.openSession({
      cwd: dir,
      signal: controller.signal,
      log: log(),
      onPermission: () => 'yes',
    });
    const { updates, stop } = await drain(session, '[[slow: 5000]]', async (u) => {
      if (u.kind === 'text') {
        await session.cancel();
      }
    });
    expect(stop.stopReason).toBe('cancelled');
    expect(updates[0]).toMatchObject({ kind: 'text' });

    controller.abort();
    const refused = await drain(session, '[[run: npm run build]]');
    expect(refused.updates).toContainEqual(
      expect.objectContaining({ kind: 'tool_call_update', status: 'failed' }),
    );
    session.close();
  });

  it('fails to spawn a program that never initialises or exits first', async () => {
    await expect(
      AcpAgent.spawn({
        exec: ['node', '-e', 'setInterval(() => undefined, 1000)'],
        env: { PATH: process.env.PATH ?? '' },
        log: log(),
        initTimeoutMs: 300,
      }),
    ).rejects.toThrow(/no initialize response after 300ms/);
    await expect(
      AcpAgent.spawn({
        exec: ['node', '-e', 'process.exit(2)'],
        env: { PATH: process.env.PATH ?? '' },
        log: log(),
      }),
    ).rejects.toThrow(/exited with code 2 before completing initialize/);
  });

  it('reports the process exit and closes the connection', async () => {
    const a = await spawnFake();
    const session = await a.openSession({
      cwd: dir,
      signal: new AbortController().signal,
      log: log(),
      onPermission: () => 'yes',
    });
    await expect(drain(session, '[[crash]]')).rejects.toThrow();
    await a.exited;
    await a.closed;
    agent = undefined;
  });
});

describe('normalise', () => {
  it('maps wire updates and permission requests to the runner shapes', () => {
    expect(
      normaliseUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'c',
        title: 'Run',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
        locations: [{ path: '/x' }],
      }),
    ).toEqual({
      kind: 'tool_call',
      id: 'c',
      title: 'Run',
      toolKind: 'execute',
      status: 'in_progress',
      command: 'ls',
      locations: ['/x'],
    });
    expect(
      normaliseUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'T' }),
    ).toMatchObject({ toolKind: 'other', status: 'pending', command: undefined, locations: [] });
    expect(
      normaliseUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: '', mimeType: 'image/png' },
      }),
    ).toEqual({ kind: 'text', text: '[image]', messageId: null });
    expect(normaliseUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toEqual({
      kind: 'usage',
      used: 1,
      size: 2,
      costUsd: undefined,
    });
    expect(normaliseUpdate({ sessionUpdate: 'plan', entries: [] })).toEqual({
      kind: 'other',
      sessionUpdate: 'plan',
    });
    expect(
      normalisePermission({
        sessionId: 's',
        toolCall: { toolCallId: 'c', kind: 'edit', locations: [{ path: '/a' }] },
        options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }],
      }),
    ).toEqual({
      toolCall: { id: 'c', title: '', toolKind: 'edit', command: undefined, locations: ['/a'] },
      options: [{ optionId: 'o', kind: 'allow_once' }],
    });
  });
});
