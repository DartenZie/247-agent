/**
 * The connector's config, as the core passes it in `OA_CONFIG_JSON` (secrets already
 * rendered). One backend (`telegram`, the default, or `matrix`), one token and one chat the
 * bot talks to; other chats are ignored unless listed in `allowed_chat_ids`.
 */
import { z } from 'zod';

/** Telegram chat ids are integers (negative for groups); accept them as numbers or strings. */
const telegramChatId = z
  .union([z.string().trim().min(1), z.number().int()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+$/.test(v) || v.startsWith('@'), {
    message: 'must be a numeric chat id or a public @channelname',
  });

/** A Matrix room id (`!opaque:server`) or alias (`#name:server`), resolved by joining at start. */
const matrixRoom = z
  .string()
  .trim()
  .regex(/^[!#][^:\s]+:\S+$/, 'must be a room id (!abc:example.org) or alias (#ops:example.org)');

/** Keys both backends share, with the same meaning and defaults. */
const common = {
  /** The bot's credential (`${secrets.<name>}`): a Bot API token, or a Matrix access token. */
  token: z.string().trim().min(1),
  /** First start without a stored cursor: `none` skips the backlog, `all` delivers it. */
  initial: z.enum(['none', 'all']).default('none'),
  /** Answered questions remembered in state, so a late answer to an old question is recognised. */
  pending_limit: z.number().int().min(1).default(200),
  /** Timeout per API call in milliseconds; the long poll gets `poll_timeout` on top. */
  timeout: z.number().int().min(1).default(30_000),
};

const telegram = z.object({
  backend: z.literal('telegram'),
  ...common,
  /** The chat `send`/`ask` post to and whose messages become `chat.message` events. */
  chat_id: telegramChatId,
  /** More chats whose messages are relayed (and that `send`/`ask` may target with `chat_id`). */
  allowed_chat_ids: z.array(telegramChatId).default([]),
  /** Long-poll wait in seconds for `getUpdates` (0 = short polling; Telegram caps it at 50). */
  poll_timeout: z.number().int().min(0).max(50).default(30),
  /** Buttons an `ask` shows when the op passes no `options`; the first one means "approved". */
  ask_options: z.array(z.string().trim().min(1)).min(1).max(20).default(['Approve', 'Reject']),
  /** Bot API base URL; only a test or a local Bot API server changes it. */
  api_base: z
    .url()
    .default('https://api.telegram.org')
    .transform((v) => v.replace(/\/+$/, '')),
});

const matrix = z.object({
  backend: z.literal('matrix'),
  ...common,
  /** The homeserver's client API base, e.g. `https://matrix.example.org`. */
  homeserver: z.url().transform((v) => v.replace(/\/+$/, '')),
  /** The room `send`/`ask` post to and whose messages become `chat.message` events. */
  chat_id: matrixRoom,
  /** More rooms whose messages are relayed (and that `send`/`ask` may target with `chat_id`). */
  allowed_chat_ids: z.array(matrixRoom).default([]),
  /** Long-poll wait in seconds for `/sync` (0 = short polling). */
  poll_timeout: z.number().int().min(0).max(120).default(30),
  /** Options an `ask` lists when the op passes none (reactions 1️⃣…🔟, so at most 10). */
  ask_options: z.array(z.string().trim().min(1)).min(1).max(10).default(['Approve', 'Reject']),
});

const schema = z.preprocess(
  (raw) =>
    raw !== null && typeof raw === 'object' && !('backend' in raw)
      ? { ...raw, backend: 'telegram' }
      : raw,
  z.discriminatedUnion('backend', [telegram, matrix]),
);

export type TelegramConfig = z.infer<typeof telegram>;
export type MatrixConfig = z.infer<typeof matrix>;
export type ChatConfig = TelegramConfig | MatrixConfig;

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
