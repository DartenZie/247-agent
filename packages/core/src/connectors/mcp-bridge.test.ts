import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../log.js';
import type { McpServerLaunch } from './acp-types.js';
import { openToolBridge, type ConnectorTools, type ToolBridge } from './mcp-bridge.js';

const tool = (name: string): Tool => ({ name, inputSchema: { type: 'object' } });

/** A connector surface: `mail` serves send/list/delete, `ftp` serves upload; calls are recorded. */
function fakeTools(): ConnectorTools & { calls: string[] } {
  const calls: string[] = [];
  const served: Record<string, Tool[]> = {
    mail: [tool('send'), tool('list'), tool('delete')],
    ftp: [tool('upload')],
  };
  return {
    calls,
    listTools: (connector) => Promise.resolve(served[connector] ?? []),
    callTool: (connector, op, args): Promise<CallToolResult> => {
      calls.push(`${connector}.${op}`);
      if (op === 'list') {
        return Promise.reject(new Error('connector "mail" is not running'));
      }
      return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({ op, args }) }] });
    },
  };
}

let dir: string;
let bridge: ToolBridge | undefined;
let lines: Record<string, unknown>[];
const clients: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-br-'));
  lines = [];
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await bridge?.close();
  bridge = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function open(
  tools: ConnectorTools,
  signal = new AbortController().signal,
): Promise<ToolBridge> {
  bridge = await openToolBridge({
    grants: [
      { connector: 'mail', ops: ['send', 'list'] },
      { connector: 'ftp', ops: [] },
    ],
    tools,
    dir: join(dir, '.mcp'),
    signal,
    log: createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }),
  });
  return bridge;
}

/** Launches the proxy exactly as an agent would from the `mcpServers` entry. */
async function launch(spec: McpServerLaunch): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env }),
  );
  clients.push(client);
  return client;
}

function server(b: ToolBridge, name: string): McpServerLaunch {
  const spec = b.servers.find((s) => s.name === name);
  if (spec === undefined) {
    throw new Error(`no server ${name}`);
  }
  return spec;
}

describe('openToolBridge', () => {
  it('offers one proxy per grant that carries no more than the socket and a token', async () => {
    const b = await open(fakeTools());
    expect(b.servers.map((s) => s.name)).toEqual(['mail', 'ftp']);
    const spec = server(b, 'mail');
    expect(spec.command).toBe(process.execPath);
    expect(Object.keys(spec.env).sort()).toEqual([
      'OA_MCP_SERVER',
      'OA_MCP_SOCKET',
      'OA_MCP_TOKEN',
    ]);
    const socket = spec.env.OA_MCP_SOCKET ?? '';
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '.mcp')).mode & 0o777).toBe(0o700);
  });

  it('lists and calls only the granted ops', async () => {
    const tools = fakeTools();
    const b = await open(tools);
    const mail = await launch(server(b, 'mail'));
    expect((await mail.listTools()).tools.map((t) => t.name)).toEqual(['send', 'list']);
    expect(await mail.callTool({ name: 'send', arguments: { to: 'a@b' } })).toEqual({
      content: [{ type: 'text', text: '{"op":"send","args":{"to":"a@b"}}' }],
    });
    expect(await mail.callTool({ name: 'delete', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: 'delete is not one of the ops this run may call on mail' }],
    });
    // A failure on the core side reaches the agent as a tool error, not a dropped connection.
    expect(await mail.callTool({ name: 'list', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: 'connector "mail" is not running' }],
    });
    const ftp = await launch(server(b, 'ftp'));
    expect((await ftp.listTools()).tools.map((t) => t.name)).toEqual(['upload']);
    expect(await ftp.callTool({ name: 'nope', arguments: {} })).toMatchObject({ isError: true });
    expect(tools.calls).toEqual(['mail.send', 'mail.list']);
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'agent.mcp_call', connector: 'mail', op: 'send', ok: true }),
    );
  });

  it('drops a client with a wrong token or an ungranted server name', async () => {
    const b = await open(fakeTools());
    const spec = server(b, 'mail');
    const attempt = (hello: string): Promise<string> =>
      new Promise((resolve) => {
        const sock = connect(spec.env.OA_MCP_SOCKET ?? '');
        let got = '';
        sock.on('connect', () => {
          sock.write(hello + '\n');
          sock.write(
            JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n',
          );
        });
        sock.on('data', (d: Buffer) => (got += d.toString()));
        sock.on('error', () => undefined);
        sock.on('close', () => {
          resolve(got);
        });
      });
    expect(await attempt(JSON.stringify({ token: 'x'.repeat(32), server: 'mail' }))).toBe('');
    expect(await attempt(JSON.stringify({ token: spec.env.OA_MCP_TOKEN, server: 'github' }))).toBe(
      '',
    );
    expect(await attempt('not json')).toBe('');
    expect(lines.filter((l) => l.msg === 'agent.mcp_refused').map((l) => l.reason)).toEqual([
      'bad token',
      'not granted',
      'bad hello',
    ]);
  });

  it('aborts calls with the run and removes the socket on close', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const tools: ConnectorTools = {
      listTools: () => Promise.resolve([tool('send')]),
      callTool: (_c, _o, _a, opts) => {
        seen = opts.signal;
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      },
    };
    const b = await open(tools, ac.signal);
    const mail = await launch(server(b, 'mail'));
    const pending = mail.callTool({ name: 'send', arguments: {} });
    await expect.poll(() => seen).toBeDefined();
    ac.abort();
    expect(await pending).toMatchObject({ isError: true, content: [{ text: 'aborted' }] });
    const socket = server(b, 'mail').env.OA_MCP_SOCKET ?? '';
    await b.close();
    await b.close();
    expect(existsSync(socket)).toBe(false);
  });
});
