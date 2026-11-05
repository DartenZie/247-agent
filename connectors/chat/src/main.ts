/**
 * The chat connector: a Telegram bot or a Matrix user (`backend`). Ops `send` and `ask`;
 * events `chat.message` and `chat.reply`, the same shapes on both backends. Spawned by the
 * core with the manifest's `config` in `OA_CONFIG_JSON`; see README.md.
 */
import { runConnector } from '@247-agent/connector-sdk';

import { ChatBot, whoAmI } from './bot.js';
import { parseConfig } from './config.js';
import { createMatrixApi } from './matrix.js';
import { MatrixBot } from './matrix-bot.js';
import { createTelegramApi } from './telegram.js';
import { chatTools, type Bot } from './tools.js';

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
    return chatTools(b);
  },
});
