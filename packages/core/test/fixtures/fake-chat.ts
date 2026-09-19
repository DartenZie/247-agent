/**
 * A fake chat connector: `ask` answers itself after a short delay by emitting `chat.reply`
 * (approved unless the manifest's `config.approve` is false); `send` appends the text to
 * the connector's `sent` state so tests can see what was said.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '../../../connector-sdk/src/index.ts';

await runConnector({
  tools: (rt) => {
    const approve = rt.env.config.approve !== false;
    const delayMs = typeof rt.env.config.delay_ms === 'number' ? rt.env.config.delay_ms : 50;
    return [
      defineTool({
        name: 'ask',
        input: { text: z.string(), correlation_id: z.string().optional() },
        handler: (args) => {
          void (async () => {
            await sleep(delayMs);
            await rt.core.emitEvent({
              type: 'chat.reply',
              correlation_id: args.correlation_id,
              payload: {
                correlation_id: args.correlation_id ?? null,
                approved: approve,
                text: approve ? 'yes' : 'no',
              },
            });
          })().catch((err: unknown) => {
            rt.log(`reply failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          return { asked: true, question: args.text };
        },
      }),
      defineTool({
        name: 'send',
        input: { text: z.string() },
        handler: async (args) => {
          const sent = ((await rt.core.getState('sent')) ?? []) as JsonValue[];
          sent.push(args.text);
          await rt.core.putState('sent', sent);
          return { sent: true, count: sent.length };
        },
      }),
    ];
  },
});
