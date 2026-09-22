/**
 * A fake ACP agent for supervisor, runner and integration tests: a compliant Agent Client
 * Protocol program (JSON-RPC over stdio, protocol version 1) whose behaviour is scripted by
 * markers in the prompt text, so a test controls it through the task's `prompt`:
 *
 *   [[run: npm run build]]   one `execute` tool call for that command, after asking permission
 *   [[edit: path]]           one `edit` tool call on <cwd>/path (asks permission; writes the file if allowed)
 *   [[tools: N]]             N `read` tool calls with no permission request
 *   [[result: {...}]]        write that JSON as RESULT.json in cwd (a nudge turn writes a default one
 *                            unless the first prompt said [[never-result]])
 *   [[cost: 0.25]]           this turn's cost (default 0.01); reported as cumulative session cost
 *   [[no-cost]]              send no usage_update;  [[no-usage]]  return no usage either
 *   [[slow: ms]]             keep the turn going for ms, checking for session/cancel
 *   [[refuse]]               end the turn with stopReason: refusal
 *   [[crash]]                exit the process with code 3 during the turn
 *
 * Run with `node fake-acp.ts` (Node strips the types).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentContext,
} from '@agentclientprotocol/sdk';

interface Session {
  cwd: string;
  cancelled: boolean;
  costUsd: number;
  neverResult: boolean;
}

const sessions = new Map<string, Session>();
let counter = 0;

function marker(prompt: string, name: string): string | undefined {
  const m = new RegExp(`\\[\\[${name}:\\s*([^\\]]*)\\]\\]`).exec(prompt);
  return m?.[1]?.trim();
}

function flag(prompt: string, name: string): boolean {
  return prompt.includes(`[[${name}]]`);
}

process.stderr.write(`fake-acp starting pid=${String(process.pid)}\n`);

async function askPermission(
  client: AgentContext,
  sessionId: string,
  call: {
    toolCallId: string;
    title: string;
    kind: 'execute' | 'edit';
    rawInput?: unknown;
    locations?: { path: string }[];
  },
): Promise<boolean> {
  const res = await client.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: { ...call, status: 'pending' },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  });
  return res.outcome.outcome === 'selected' && res.outcome.optionId !== 'no';
}

const app = agent({ name: 'fake-acp' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: 'fake-acp', version: '0.1.0' },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, (ctx) => {
    counter += 1;
    const sessionId = `sess_${String(counter)}`;
    sessions.set(sessionId, {
      cwd: ctx.params.cwd,
      cancelled: false,
      costUsd: 0,
      neverResult: false,
    });
    process.stderr.write(`fake-acp session ${sessionId} cwd=${ctx.params.cwd}\n`);
    return { sessionId };
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (s !== undefined) {
      s.cancelled = true;
    }
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    const s = sessions.get(sessionId);
    if (s === undefined) {
      throw new Error(`unknown session ${sessionId}`);
    }
    const prompt = ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const client = ctx.client;
    const update = (u: Record<string, unknown>): Promise<void> =>
      client.notify(methods.client.session.update, {
        sessionId,
        update: u as never,
      });
    const stop = async (
      stopReason: 'end_turn' | 'refusal' | 'cancelled',
    ): Promise<{ stopReason: typeof stopReason; usage?: unknown }> => {
      if (!flag(prompt, 'no-cost')) {
        s.costUsd += Number(marker(prompt, 'cost') ?? '0.01');
        await update({
          sessionUpdate: 'usage_update',
          used: 1200,
          size: 200_000,
          cost: { amount: s.costUsd, currency: 'USD' },
        });
      }
      return flag(prompt, 'no-usage')
        ? { stopReason }
        : { stopReason, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } };
    };

    if (flag(prompt, 'crash')) {
      process.stderr.write('fake-acp crashing\n');
      setTimeout(() => process.exit(3), 10);
      await sleep(1000);
    }
    if (flag(prompt, 'never-result')) {
      s.neverResult = true;
    }
    await update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Working on it. ' },
    });

    const run = marker(prompt, 'run');
    if (run !== undefined) {
      const toolCallId = `call_${String(++counter)}`;
      await update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `Run ${run}`,
        kind: 'execute',
        status: 'pending',
        rawInput: { command: run },
      });
      const ok = await askPermission(client, sessionId, {
        toolCallId,
        title: `Run ${run}`,
        kind: 'execute',
        rawInput: { command: run },
      });
      process.stderr.write(`fake-acp run "${run}" ${ok ? 'allowed' : 'rejected'}\n`);
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: ok ? 'completed' : 'failed',
      });
    }

    const edit = marker(prompt, 'edit');
    if (edit !== undefined) {
      const toolCallId = `call_${String(++counter)}`;
      const path = resolve(s.cwd, edit);
      await update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `Edit ${edit}`,
        kind: 'edit',
        status: 'pending',
        locations: [{ path }],
      });
      const ok = await askPermission(client, sessionId, {
        toolCallId,
        title: `Edit ${edit}`,
        kind: 'edit',
        locations: [{ path }],
      });
      if (ok) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'edited by fake-acp\n');
      }
      process.stderr.write(`fake-acp edit "${edit}" ${ok ? 'allowed' : 'rejected'}\n`);
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: ok ? 'completed' : 'failed',
      });
    }

    const tools = Number(marker(prompt, 'tools') ?? '0');
    for (let i = 0; i < tools; i++) {
      if (s.cancelled) {
        break;
      }
      await update({
        sessionUpdate: 'tool_call',
        toolCallId: `call_${String(++counter)}`,
        title: `Read file ${String(i)}`,
        kind: 'read',
        status: 'completed',
      });
      await sleep(5);
    }

    const slow = Number(marker(prompt, 'slow') ?? '0');
    const until = Date.now() + slow;
    while (Date.now() < until && !s.cancelled) {
      await sleep(20);
    }
    if (s.cancelled) {
      process.stderr.write('fake-acp turn cancelled\n');
      return stop('cancelled');
    }

    // The JSON may hold arrays, so this marker ends at the first `}]]`, not the first `]`.
    const result = /\[\[result:\s*(\{[\s\S]*?\})\s*\]\]/.exec(prompt)?.[1];
    if (result !== undefined) {
      writeFileSync(resolve(s.cwd, 'RESULT.json'), result + '\n');
    } else if (prompt.includes('You have not written') && !s.neverResult) {
      writeFileSync(
        resolve(s.cwd, 'RESULT.json'),
        JSON.stringify({
          status: 'done',
          summary: 'written on the second ask',
          files_changed: [],
        }) + '\n',
      );
    }
    await update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done.' },
    });
    return stop(flag(prompt, 'refuse') ? 'refusal' : 'end_turn');
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
