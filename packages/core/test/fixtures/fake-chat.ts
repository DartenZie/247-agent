/**
 * A fake chat connector with the real one's op and event shapes (connectors/chat): `ask`
 * answers itself after `config.delay_ms` by emitting `chat.reply` (approved, i.e. the first
 * option, unless `config.approve` is false) and records the question in the `asked` state
 * key; `send` appends the text to the `sent` state key so tests can see what was said.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '../../../connector-sdk/src/index.ts';

await runConnector({
  tools: (rt) => {
    const approve = rt.env.config.approve !== false;
    const delayMs = typeof rt.env.config.delay_ms === 'number' ? rt.env.config.delay_ms : 50;
    const chatId = String(rt.env.config.chat_id ?? '1');
    const from = { id: 7, name: 'Fake Human', username: 'fake' };
    let nextMessageId = 1;
    return [
      defineTool({
        name: 'ask',
        input: {
          text: z.string(),
          correlation_id: z.string().optional(),
          options: z.array(z.string()).optional(),
        },
        handler: async (args) => {
          const message_id = nextMessageId++;
          const options = args.options ?? ['Approve', 'Reject'];
          const asked = ((await rt.core.getState('asked')) ?? []) as JsonValue[];
          asked.push(args.text);
          await rt.core.putState('asked', asked);
          void (async () => {
            await sleep(delayMs);
            const choice = approve ? options[0] : (options[1] ?? options[0]);
            await rt.core.emitEvent({
              type: 'chat.reply',
              correlation_id: args.correlation_id,
              dedup_key: `chat:reply:${chatId}:${String(message_id)}`,
              payload: {
                correlation_id: args.correlation_id ?? null,
                approved: approve,
                choice: choice ?? '',
                text: choice ?? '',
                from,
                message_id,
                chat_id: chatId,
                answer_message_id: null,
              },
            });
          })().catch((err: unknown) => {
            rt.log(`reply failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          return { message_id, chat_id: chatId, options };
        },
      }),
      defineTool({
        name: 'send',
        input: { text: z.string() },
        handler: async (args) => {
          const sent = ((await rt.core.getState('sent')) ?? []) as JsonValue[];
          sent.push(args.text);
          await rt.core.putState('sent', sent);
          return { message_id: nextMessageId++, chat_id: chatId };
        },
      }),
    ];
  },
});
