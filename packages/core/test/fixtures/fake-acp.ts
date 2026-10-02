/**
 * A fake ACP agent for supervisor, runner and integration tests: a compliant Agent Client
 * Protocol program (JSON-RPC over stdio, protocol version 1) whose behaviour is scripted by
 * markers in the prompt text, so a test controls it through the task's `prompt`:
 *
 *   [[run: npm run build]]   one `execute` tool call for that command, after asking permission
 *   [[edit: path]]           one `edit` tool call on <cwd>/path (asks permission; writes the file if allowed)
 *   [[tools: N]]             N `read` tool calls with no permission request
 *   [[mcp: server op {...}]] after asking permission (kind `other`), launch the session's MCP
 *                            server `server` (from session/new), list its tools, call `op` with
 *                            the JSON args and write {tools, result} (or {tools, error}) to
 *                            <cwd>/MCP_RESULT.json
 *   [[result: {...}]]        write that JSON as RESULT.json in cwd (a nudge turn writes a default one
 *                            unless the first prompt said [[never-result]])
 *   [[cost: 0.25]]           this turn's cost (default 0.01); reported as cumulative session cost
 *   [[no-cost]]              send no usage_update;  [[no-usage]]  return no usage either
 *   [[slow: ms]]             keep the turn going for ms, checking for session/cancel
 *   [[refuse]]               end the turn with stopReason: refusal
 *   [[crash]]                exit the process with code 3 during the turn
 *   [[config]]               write the session's {model, effort} to <cwd>/CONFIG.json
 *   [[fetch: http://…]]      GET that URL through $HTTP_PROXY (as a client behind a proxy does) and
 *                            write {proxy, status, body} (or {proxy, error}) to <cwd>/FETCH_RESULT.json
 *
 * Every session offers two config options, like claude-agent-acp: `model` (category
 * `model`, values in groups: `default`, `claude-sonnet-5`, `claude-opus-5`) and `effort` (category
 * `thought_level`: `low`, `medium`, plus `high` on `claude-opus-5`; switching the model
 * resets it to `medium` when the level is gone). An unknown value is an error.
 *
 * Run with `node fake-acp.ts` (Node strips the types).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentContext,
  type McpServer,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface Session {
  cwd: string;
  mcpServers: McpServer[];
  cancelled: boolean;
  costUsd: number;
  neverResult: boolean;
  model: string;
  effort: string;
}

function effortLevels(model: string): string[] {
  return model === 'claude-opus-5' ? ['low', 'medium', 'high'] : ['low', 'medium'];
}

function configOptions(s: Session): SessionConfigOption[] {
  const levels = (values: string[]) => values.map((value) => ({ value, name: value }));
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: [
        { group: 'auto', name: 'Auto', options: levels(['default']) },
        { group: 'fake', name: 'Fake', options: levels(['claude-sonnet-5', 'claude-opus-5']) },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: s.effort,
      options: levels(effortLevels(s.model)),
    },
  ];
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

/** GET `url` the way an HTTP client behind `HTTP_PROXY` does: in absolute form, to the proxy. */
function fetchViaProxy(proxy: string, url: string): Promise<{ status: number; body: string }> {
  const p = new URL(proxy);
  return new Promise((done, fail) => {
    const req = httpRequest(
      { host: p.hostname, port: p.port, path: url, headers: { host: new URL(url).host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          done({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', fail);
    req.end();
  });
}

process.stderr.write(`fake-acp starting pid=${String(process.pid)}\n`);

async function askPermission(
  client: AgentContext,
  sessionId: string,
  call: {
    toolCallId: string;
    title: string;
    kind: 'execute' | 'edit' | 'other';
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
      mcpServers: ctx.params.mcpServers,
      cancelled: false,
      costUsd: 0,
      neverResult: false,
      model: 'default',
      effort: 'medium',
    });
    process.stderr.write(`fake-acp session ${sessionId} cwd=${ctx.params.cwd}\n`);
    return { sessionId, configOptions: configOptions(sessions.get(sessionId) as Session) };
  })
  .onRequest(methods.agent.session.setConfigOption, (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (s === undefined) {
      throw new Error(`unknown session ${ctx.params.sessionId}`);
    }
    const { configId, value } = ctx.params;
    if (
      configId === 'model' &&
      ['default', 'claude-sonnet-5', 'claude-opus-5'].includes(String(value))
    ) {
      s.model = String(value);
      if (!effortLevels(s.model).includes(s.effort)) {
        s.effort = 'medium';
      }
    } else if (configId === 'effort' && effortLevels(s.model).includes(String(value))) {
      s.effort = String(value);
    } else {
      throw new Error(`Invalid value for config option ${configId}: ${String(value)}`);
    }
    process.stderr.write(`fake-acp config ${configId}=${String(value)}\n`);
    return { configOptions: configOptions(s) };
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
    if (flag(prompt, 'config')) {
      writeFileSync(
        resolve(s.cwd, 'CONFIG.json'),
        JSON.stringify({ model: s.model, effort: s.effort }) + '\n',
      );
    }
    const fetchUrl = marker(prompt, 'fetch');
    if (fetchUrl !== undefined) {
      const proxy = process.env.HTTP_PROXY ?? '';
      const out = await fetchViaProxy(proxy, fetchUrl).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      writeFileSync(resolve(s.cwd, 'FETCH_RESULT.json'), JSON.stringify({ proxy, ...out }) + '\n');
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

    const mcp = /\[\[mcp:\s*(\S+)\s+(\S+)\s*(\{[\s\S]*?\})?\s*\]\]/.exec(prompt);
    if (mcp !== null) {
      const [, server = '', op = '', args = '{}'] = mcp;
      const toolCallId = `call_${String(++counter)}`;
      const title = `mcp__${server}__${op}`;
      await update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        kind: 'other',
        status: 'pending',
      });
      const ok = await askPermission(client, sessionId, { toolCallId, title, kind: 'other' });
      const out: Record<string, unknown> = {};
      const spec = s.mcpServers.find((m) => m.name === server);
      if (!ok) {
        out.error = 'permission refused';
      } else if (spec === undefined || !('command' in spec)) {
        out.error = `no stdio MCP server "${server}" in session/new`;
      } else {
        const mcpClient = new Client({ name: 'fake-acp', version: '0.1.0' });
        try {
          await mcpClient.connect(
            new StdioClientTransport({
              command: spec.command,
              args: spec.args,
              env: Object.fromEntries(spec.env.map((e) => [e.name, e.value])),
              stderr: 'inherit',
            }),
          );
          out.tools = (await mcpClient.listTools()).tools.map((t) => t.name);
          out.result = await mcpClient.callTool({ name: op, arguments: JSON.parse(args) });
        } catch (err) {
          out.error = err instanceof Error ? err.message : String(err);
        } finally {
          await mcpClient.close();
        }
      }
      writeFileSync(resolve(s.cwd, 'MCP_RESULT.json'), JSON.stringify(out) + '\n');
      process.stderr.write(`fake-acp mcp ${server}.${op} ${JSON.stringify(out).slice(0, 300)}\n`);
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: out.error === undefined ? 'completed' : 'failed',
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
