/**
 * A generic fake connector for supervisor tests: `echo` returns its args, `fail` returns an
 * MCP error, `crash` exits the process, `env` reports what the core passed in, `slow`
 * takes a while. Run with `node fake-mcp.ts` (Node strips the types).
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import {
  connectorEnv,
  createConnectorServer,
  defineTool,
  serveStdio,
} from '../../../connector-sdk/src/index.ts';

const env = connectorEnv();
process.stderr.write(`fake-mcp ${env.name} starting\n`);

const server = createConnectorServer({
  name: env.name,
  tools: [
    defineTool({
      name: 'echo',
      input: { value: z.unknown() },
      handler: (args) => ({ echoed: args.value as never }),
    }),
    defineTool({
      name: 'fail',
      input: { message: z.string() },
      handler: (args) => {
        throw new Error(args.message);
      },
    }),
    defineTool({
      name: 'crash',
      handler: () => {
        setTimeout(() => process.exit(3), 10);
        return { crashing: true };
      },
    }),
    defineTool({
      name: 'env',
      handler: () => ({
        name: env.name,
        socket: env.socket,
        config: env.config,
        extra: process.env.FAKE_EXTRA ?? null,
      }),
    }),
    defineTool({
      name: 'slow',
      input: { ms: z.number() },
      handler: async (args) => {
        await sleep(args.ms);
        return { slept: args.ms };
      },
    }),
    defineTool({ name: 'text', handler: () => 'plain text, not JSON' }),
  ],
});

await serveStdio(server);
