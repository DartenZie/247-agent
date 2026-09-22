/**
 * Pure helpers: turn a raw Telegram update into one of the things the bot cares about, and
 * encode/decode the `callback_data` of inline buttons.
 */
import type { From, TgCallbackQuery, TgInlineKeyboardButton, TgUpdate, TgUser } from './types.js';

export type Incoming =
  | {
      kind: 'message';
      chat_id: string;
      message_id: number;
      text: string;
      from: From;
      date: string;
      reply_to: number | null;
    }
  | {
      kind: 'callback';
      chat_id: string;
      message_id: number;
      query_id: string;
      data: string;
      from: From;
    }
  | { kind: 'ignored'; reason: string };

/** What the bot sees in an update: a text message, a button tap, or nothing of interest. */
export function classifyUpdate(update: TgUpdate): Incoming {
  const message = update.message ?? update.channel_post;
  if (message !== undefined) {
    const text = message.text ?? message.caption;
    if (text === undefined) {
      return { kind: 'ignored', reason: 'message without text or caption' };
    }
    return {
      kind: 'message',
      chat_id: String(message.chat.id),
      message_id: message.message_id,
      text,
      from: fromOf(message.from),
      date: new Date(message.date * 1000).toISOString(),
      reply_to: message.reply_to_message?.message_id ?? null,
    };
  }
  if (update.callback_query !== undefined) {
    return classifyCallback(update.callback_query);
  }
  if (update.edited_message !== undefined) {
    return { kind: 'ignored', reason: 'edited message' };
  }
  return { kind: 'ignored', reason: 'unsupported update kind' };
}

function classifyCallback(query: TgCallbackQuery): Incoming {
  if (query.message === undefined) {
    return { kind: 'ignored', reason: 'callback without a reachable message' };
  }
  if (query.data === undefined) {
    return { kind: 'ignored', reason: 'callback without data' };
  }
  return {
    kind: 'callback',
    chat_id: String(query.message.chat.id),
    message_id: query.message.message_id,
    query_id: query.id,
    data: query.data,
    from: fromOf(query.from),
  };
}

/** `{ id, name, username }` from a Telegram user; anonymous senders (channels) have no user. */
export function fromOf(user: TgUser | undefined): From {
  if (user === undefined) {
    return { id: null, name: '', username: null };
  }
  const name = [user.first_name, user.last_name].filter((s) => s !== undefined && s !== '');
  return { id: user.id, name: name.join(' '), username: user.username ?? null };
}

const CALLBACK_PREFIX = 'oa';

/** `oa:<nonce>:<index>` — well under Telegram's 64-byte limit for `callback_data`. */
export function encodeCallback(nonce: string, index: number): string {
  return `${CALLBACK_PREFIX}:${nonce}:${String(index)}`;
}

export function decodeCallback(data: string): { nonce: string; index: number } | undefined {
  const parts = data.split(':');
  const [prefix, nonce, rest] = parts;
  if (parts.length !== 3 || prefix !== CALLBACK_PREFIX || nonce === undefined || nonce === '') {
    return undefined;
  }
  const index = Number(rest);
  if (!Number.isInteger(index) || index < 0) {
    return undefined;
  }
  return { nonce, index };
}

/** One row for up to three options, one option per row beyond that. */
export function inlineKeyboard(options: string[], nonce: string): TgInlineKeyboardButton[][] {
  const buttons = options.map((text, index) => ({
    text,
    callback_data: encodeCallback(nonce, index),
  }));
  return buttons.length <= 3 ? [buttons] : buttons.map((b) => [b]);
}

/** The option a typed answer names (case- and whitespace-insensitive), if any. */
export function matchOption(text: string, options: string[]): string | undefined {
  const wanted = text.trim().toLowerCase();
  if (wanted === '') {
    return undefined;
  }
  return options.find((o) => o.trim().toLowerCase() === wanted);
}
