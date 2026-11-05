import { readFileSync } from 'node:fs';

import { listTools } from '@247-agent/connector-sdk/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { emailTools } from './tools.js';

const example = parse(
  readFileSync(new URL('../../../docs/examples/connectors.d/email.yaml', import.meta.url), 'utf8'),
) as { ops: string[] };

describe('email tool registrations', () => {
  it('lists the example manifest ops over MCP', async () => {
    const tools = await listTools(
      emailTools({ mailbox: undefined, outgoing: undefined, log: () => undefined }),
    );
    expect(tools.map((t) => t.name).sort()).toEqual([...example.ops].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });
});
