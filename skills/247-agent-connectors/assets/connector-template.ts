/**
 * Template for a TypeScript 247-agent connector. Copy to connectors/<name>/src/main.ts,
 * replace the tools, and point the manifest's `exec` at the built file.
 *
 * Rules: stdout is the MCP channel, so log with rt.log (stderr). Keep cursors in the core
 * with rt.core.getState/putState. Throw inside a handler to fail the calling run.
 */
import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '@247-agent/connector-sdk';

interface Item {
  id: string;
  [k: string]: JsonValue;
}

await runConnector({
  version: '0.1.0',

  // Optional: start a listener or bot here for push-style events.
  setup: async (rt) => {
    rt.log(`starting with config keys: ${Object.keys(rt.env.config).join(', ')}`);
  },

  tools: (rt) => [
    defineTool({
      name: 'fetch_new',
      description: 'Items newer than the stored cursor; returns the new cursor',
      input: { since: z.string().nullable().optional() },
      handler: async (args) => {
        const cursor = args.since ?? ((await rt.core.getState('cursor')) as string | null);
        const items: Item[] = []; // fetch from the external system here
        const next = items.length > 0 ? items[items.length - 1]!.id : cursor;
        if (next !== null && next !== undefined) {
          await rt.core.putState('cursor', next);
        }
        return { items: items as unknown as JsonValue, cursor: next ?? null };
      },
    }),

    defineTool({
      name: 'send',
      description: 'Send a message',
      input: { text: z.string() },
      handler: async (args) => {
        // deliver args.text; throw new Error('...') on failure
        return { sent: true, length: args.text.length };
      },
    }),
  ],
});
