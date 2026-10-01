/**
 * The chat connector: a Telegram bot or a Matrix user (`backend`). Ops `send` and `ask`;
 * events `chat.message` and `chat.reply`, the same shapes on both backends. Spawned by the
 * core with the manifest's `config` in `OA_CONFIG_JSON`; see README.md.
 */
import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '@247-agent/connector-sdk';

import { ChatBot, whoAmI, type AskArgs, type SendArgs, type SentMessage } from './bot.js';
import { parseConfig } from './config.js';
import { createMatrixApi } from './matrix.js';
import { MatrixBot } from './matrix-bot.js';
import { createTelegramApi } from './telegram.js';

const parseMode = z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional();
const chatId = z.union([z.string(), z.number()]).optional();
/** A Telegram message id, or a Matrix event id. */
const replyTo = z.union([z.number().int(), z.string().min(1)]).optional();

/** What the ops need from either backend. */
interface Bot {
  send(args: SendArgs): Promise<SentMessage>;
  ask(args: AskArgs): Promise<SentMessage & { options: string[] }>;
}

let bot: Bot | undefined;

await runConnector({
  version: '0.1.0',
  setup: async (rt) => {
    const config = parseConfig(rt.env.config);
    const rooms = `${String(1 + config.allowed_chat_ids.length)} chat(s) allowed`;
    // Both fail fast on a bad token: the process exits non-zero and the supervisor backs off.
    if (config.backend === 'matrix') {
      const api = createMatrixApi({
        homeserver: config.homeserver,
        token: config.token,
        timeoutMs: config.timeout,
      });
      const matrix = new MatrixBot(config, api, rt.core, rt.log);
      const me = await matrix.init();
      rt.log(
        `chat: matrix user ${me} on ${config.homeserver}, syncing (${String(config.poll_timeout)}s), ${rooms}`,
      );
      bot = matrix;
      void matrix.start();
      return;
    }
    const api = createTelegramApi({
      token: config.token,
      apiBase: config.api_base,
      timeoutMs: config.timeout,
    });
    const me = await whoAmI(api);
    rt.log(`chat: telegram bot ${me}, long polling (${String(config.poll_timeout)}s), ${rooms}`);
    const telegram = new ChatBot(config, api, rt.core, rt.log);
    bot = telegram;
    void telegram.start();
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
          'Posts a message to the configured chat. Returns {message_id, chat_id}. reply_to quotes an earlier message (a Telegram message id, or a Matrix event id).',
        input: {
          text: z.string().min(1),
          parse_mode: parseMode,
          reply_to: replyTo,
          chat_id: chatId,
        },
        handler: async (args) => (await b.send(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'ask',
        description:
          'Posts a question with its options (Approve/Reject unless given) as inline buttons on Telegram or keycap reactions on Matrix, and emits the answer as a chat.reply event carrying correlation_id. Returns {message_id, chat_id, options}.',
        input: {
          text: z.string().min(1),
          correlation_id: z.string().optional(),
          options: z.array(z.string().min(1)).min(1).max(20).optional(),
          parse_mode: parseMode,
          reply_to: replyTo,
          chat_id: chatId,
        },
        handler: async (args) => (await b.ask(args)) as unknown as JsonValue,
      }),
    ];
  },
});
