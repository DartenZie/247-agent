import { readFileSync } from 'node:fs';

import { listTools } from '@247-agent/connector-sdk/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { chatTools, type Bot } from './tools.js';

const example = parse(
  readFileSync(new URL('../../../docs/examples/connectors.d/chat.yaml', import.meta.url), 'utf8'),
) as { ops: string[] };

describe('chat tool registrations', () => {
  it('lists the example manifest ops over MCP', async () => {
    const tools = await listTools(chatTools({} as Bot));
    expect(tools.map((t) => t.name).sort()).toEqual([...example.ops].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });
});
