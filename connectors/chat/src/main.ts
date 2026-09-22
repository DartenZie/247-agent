/**
 * The chat connector: a Telegram bot. Ops `send` and `ask`; events `chat.message` and
 * `chat.reply`. Spawned by the core with the manifest's `config` in `OA_CONFIG_JSON`; see
 * README.md.
 */
import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '@247-agent/connector-sdk';

import { ChatBot, whoAmI } from './bot.js';
import { parseConfig } from './config.js';
import { createTelegramApi } from './telegram.js';

const parseMode = z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional();
const chatId = z.union([z.string(), z.number()]).optional();

let bot: ChatBot | undefined;

await runConnector({
  version: '0.1.0',
  setup: async (rt) => {
    const config = parseConfig(rt.env.config);
    const api = createTelegramApi({
      token: config.token,
      apiBase: config.api_base,
      timeoutMs: config.timeout,
    });
    // Fails fast on a bad token: the process exits non-zero and the supervisor backs off.
    const me = await whoAmI(api);
    rt.log(
      `chat: telegram bot ${me}, long polling (${String(config.poll_timeout)}s), ` +
        `${String(1 + config.allowed_chat_ids.length)} chat(s) allowed`,
    );
    bot = new ChatBot(config, api, rt.core, rt.log);
    void bot.start();
  },
  tools: () => {
    const b = bot;
    if (b === undefined) {
      throw new Error('chat: setup did not run');
    }
    return [
      defineTool({
        name: 'send',
        description:
          'Posts a message to the configured chat. Returns {message_id, chat_id}. reply_to quotes an earlier message.',
        input: {
          text: z.string().min(1),
          parse_mode: parseMode,
          reply_to: z.number().int().optional(),
          chat_id: chatId,
        },
        handler: async (args) => (await b.send(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'ask',
        description:
          'Posts a question with inline buttons (Approve/Reject unless options are given) and emits the answer as a chat.reply event carrying correlation_id. Returns {message_id, chat_id, options}.',
        input: {
          text: z.string().min(1),
          correlation_id: z.string().optional(),
          options: z.array(z.string().min(1)).min(1).max(20).optional(),
          parse_mode: parseMode,
          reply_to: z.number().int().optional(),
          chat_id: chatId,
        },
        handler: async (args) => (await b.ask(args)) as unknown as JsonValue,
      }),
    ];
  },
});
