import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool } from './index.js';
import { listTools } from './testing.js';

describe('listTools', () => {
  it('returns the registered tools as an MCP client lists them, without running a handler', async () => {
    let calls = 0;
    const tools = await listTools([
      defineTool({
        name: 'greet',
        description: 'Says hello.',
        input: { who: z.string() },
        handler: () => {
          calls++;
          return 'hi';
        },
      }),
      defineTool({ name: 'ping', handler: () => 'pong' }),
    ]);
    expect(tools.map((t) => t.name)).toEqual(['greet', 'ping']);
    expect(tools[0]?.description).toBe('Says hello.');
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { who: { type: 'string' } },
      required: ['who'],
    });
    expect(calls).toBe(0);
  });
});
