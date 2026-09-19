import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  connectorEnv,
  CoreApiError,
  CoreClient,
  createConnectorServer,
  defineTool,
} from './index.js';

describe('connectorEnv', () => {
  it('reads the variables the core sets and parses the config', () => {
    expect(
      connectorEnv({ OA_CORE_SOCKET: '/s', OA_CONNECTOR_NAME: 'email', OA_CONFIG_JSON: '{"a":1}' }),
    ).toEqual({ socket: '/s', name: 'email', config: { a: 1 } });
    expect(connectorEnv({ OA_CORE_SOCKET: '/s', OA_CONNECTOR_NAME: 'email' }).config).toEqual({});
    expect(() => connectorEnv({})).toThrow(/OA_CORE_SOCKET/);
  });
});

describe('createConnectorServer', () => {
  it('serves tools whose JSON results and errors the core can read', async () => {
    const server = createConnectorServer({
      name: 't',
      tools: [
        defineTool({
          name: 'add',
          input: { a: z.number(), b: z.number() },
          handler: ({ a, b }) => ({ sum: a + b }),
        }),
        {
          name: 'boom',
          handler: () => {
            throw new Error('kaboom');
          },
        },
      ],
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['add', 'boom']);
    const ok = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(ok.content).toEqual([{ type: 'text', text: '{"sum":5}' }]);
    const bad = await client.callTool({ name: 'boom', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(bad.content).toEqual([{ type: 'text', text: 'kaboom' }]);
    await client.close();
    await server.close();
  });
});

describe('CoreClient', () => {
  let dir: string;
  let http: Server;
  let socket: string;
  let requests: { method: string; url: string; body: string }[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-sdk-'));
    socket = join(dir, 'c.sock');
    requests = [];
    http = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        const reply = (status: number, json: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        };
        if (req.url === '/v1/events') {
          reply(201, { status: 'inserted', event: { id: 'evt_1', correlation_id: 'cor_1' } });
        } else if (req.url === '/v1/state/chat/missing') {
          reply(404, { error: 'no state' });
        } else if (req.method === 'PUT') {
          reply(200, {
            namespace: 'chat',
            key: 'sent',
            value: (JSON.parse(body) as { value: unknown }).value,
            updated_at: 'now',
          });
        } else if (req.url === '/v1/state/chat/sent') {
          reply(200, { namespace: 'chat', key: 'sent', value: ['a'], updated_at: 'now' });
        } else {
          reply(500, { error: 'boom' });
        }
      });
    });
    await new Promise<void>((r) => {
      http.listen(socket, r);
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => {
      http.close(() => {
        r();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits events with its own name as source and uses its namespace for state', async () => {
    const core = new CoreClient({ socket, name: 'chat' });
    await expect(
      core.emitEvent({ type: 'chat.reply', payload: { ok: true }, correlation_id: 'cor_1' }),
    ).resolves.toMatchObject({ status: 'inserted' });
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/v1/events' });
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
      type: 'chat.reply',
      source: 'chat',
      payload: { ok: true },
      correlation_id: 'cor_1',
    });

    await expect(core.getState('sent')).resolves.toEqual(['a']);
    await expect(core.getState('missing')).resolves.toBeUndefined();
    await core.putState('sent', ['a', 'b']);
    expect(requests[3]).toMatchObject({
      method: 'PUT',
      url: '/v1/state/chat/sent',
      body: '{"value":["a","b"]}',
    });
    await expect(core.getState('x', 'other')).rejects.toThrow(CoreApiError);
    await expect(core.getState('x', 'other')).rejects.toThrow('boom');
  });
});
