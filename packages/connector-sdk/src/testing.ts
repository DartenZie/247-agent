/**
 * Test helpers for connectors: `@247-agent/connector-sdk/testing`. Never imported by a
 * connector's runtime code.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { createConnectorServer, type ToolDef } from './index.js';

/**
 * Registers `tools` on a connector server, as `runConnector` does, and returns what an MCP
 * client sees from `tools/list` over an in-memory transport: names, descriptions and the
 * JSON Schemas built from the zod shapes. No handler runs.
 */
export async function listTools(tools: ToolDef[]): Promise<Tool[]> {
  const server = createConnectorServer({ name: 'test', tools });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}
