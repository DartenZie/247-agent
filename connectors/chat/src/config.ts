/**
 * The connector's config, as the core passes it in `OA_CONFIG_JSON` (secrets already
 * rendered). One bot token and one chat the bot talks to; other chats are ignored unless
 * listed in `allowed_chat_ids`.
 */
import { z } from 'zod';

/** Telegram chat ids are integers (negative for groups); accept them as numbers or strings. */
const chatId = z
  .union([z.string().trim().min(1), z.number().int()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+$/.test(v) || v.startsWith('@'), {
    message: 'must be a numeric chat id or a public @channelname',
  });

const schema = z.object({
  /** Only `telegram` today; the key exists so a Matrix backend can be added without renaming anything. */
  backend: z.literal('telegram').default('telegram'),
  /** The bot token from @BotFather (`${secrets.<name>}`). */
  token: z.string().trim().min(1),
  /** The chat `send`/`ask` post to and whose messages become `chat.message` events. */
  chat_id: chatId,
  /** More chats whose messages are relayed (and that `send`/`ask` may target with `chat_id`). */
  allowed_chat_ids: z.array(chatId).default([]),
  /** Long-poll wait in seconds for `getUpdates` (0 = short polling; Telegram caps it at 50). */
  poll_timeout: z.number().int().min(0).max(50).default(30),
  /** First start without a stored offset: `none` skips the backlog Telegram kept, `all` delivers it. */
  initial: z.enum(['none', 'all']).default('none'),
  /** Buttons an `ask` shows when the op passes no `options`; the first one means "approved". */
  ask_options: z.array(z.string().trim().min(1)).min(1).max(20).default(['Approve', 'Reject']),
  /** Answered questions remembered in state, so a late tap on an old question is recognised. */
  pending_limit: z.number().int().min(1).default(200),
  /** Bot API base URL; only a test or a local Bot API server changes it. */
  api_base: z
    .url()
    .default('https://api.telegram.org')
    .transform((v) => v.replace(/\/+$/, '')),
  /** Timeout per Bot API call in milliseconds; `getUpdates` gets `poll_timeout` on top. */
  timeout: z.number().int().min(1).default(30_000),
});

export type ChatConfig = z.infer<typeof schema>;

/** Parses the raw config object; throws a readable error listing every problem. */
export function parseConfig(raw: unknown): ChatConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`,
    );
    throw new Error(`invalid chat connector config:\n  ${lines.join('\n  ')}`);
  }
  return result.data;
}

/** The chats the connector listens to and may post to. */
export function allowedChats(config: ChatConfig): Set<string> {
  return new Set([config.chat_id, ...config.allowed_chat_ids]);
}
