/**
 * The bot: `send` and `ask` ops, the long-poll loop and the update handler that turns
 * messages into `chat.message` events and answers to questions into `chat.reply` events.
 *
 * All state lives in the core so a restart neither replays updates nor forgets which
 * question a button belongs to: `offset` (the next `update_id`) and `pending` (question
 * message id → correlation id and options).
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { EmitInput, EmitResult, JsonValue } from '@247-agent/connector-sdk';

import { allowedChats, type ChatConfig } from './config.js';
import { TelegramError, type TelegramApi } from './telegram.js';
import type { ChatMessagePayload, ChatReplyPayload, From, TgUpdate, TgUser } from './types.js';
import { classifyUpdate, decodeCallback, inlineKeyboard, matchOption } from './updates.js';

/** What the bot needs from the core: the SDK's `CoreClient` or a fake in tests. */
export interface CoreLike {
  emitEvent(input: EmitInput): Promise<EmitResult>;
  getState(key: string): Promise<JsonValue | undefined>;
  putState(key: string, value: JsonValue): Promise<void>;
}

export interface SendArgs {
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2' | undefined;
  reply_to?: number | undefined;
  chat_id?: string | number | undefined;
}

export interface AskArgs extends SendArgs {
  correlation_id?: string | undefined;
  options?: string[] | undefined;
}

export interface SentMessage {
  message_id: number;
  chat_id: string;
  [key: string]: JsonValue;
}

interface Pending {
  correlation_id: string | null;
  options: string[];
  nonce: string;
  chat_id: string;
  asked_at: string;
  [key: string]: JsonValue;
}

type PendingMap = Record<string, Pending>;

export const STATE_OFFSET = 'offset';
export const STATE_PENDING = 'pending';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** A poison update is skipped after this many failed attempts. */
const MAX_UPDATE_ATTEMPTS = 3;

export class ChatBot {
  private readonly allowed: Set<string>;
  private readonly ignoredChats = new Set<string>();
  private offset: number | undefined;
  private offsetLoaded = false;
  private stopped = false;
  private failing: { update_id: number; attempts: number } | undefined;

  constructor(
    private readonly config: ChatConfig,
    private readonly api: TelegramApi,
    private readonly core: CoreLike,
    private readonly log: (line: string) => void,
    private readonly sleepFn: (ms: number) => Promise<void> = (ms) => sleep(ms),
  ) {
    this.allowed = allowedChats(config);
  }

  /** Posts a message; `reply_to` quotes an earlier message of the same chat. */
  async send(args: SendArgs): Promise<SentMessage> {
    const chat_id = this.targetChat(args.chat_id);
    const result = await this.api.call<{ message_id: number }>('sendMessage', {
      chat_id,
      text: args.text,
      ...(args.parse_mode === undefined ? {} : { parse_mode: args.parse_mode }),
      ...(args.reply_to === undefined ? {} : { reply_parameters: { message_id: args.reply_to } }),
    });
    return { message_id: result.message_id, chat_id };
  }

  /**
   * Posts a question with one inline button per option and remembers it in state, so the
   * tap (or a text reply naming an option) becomes a `chat.reply` carrying `correlation_id`.
   */
  async ask(args: AskArgs): Promise<SentMessage & { options: string[] }> {
    const chat_id = this.targetChat(args.chat_id);
    const options = (args.options ?? this.config.ask_options).map((o) => o.trim());
    if (options.length === 0 || options.some((o) => o === '')) {
      throw new Error('ask: options must be non-empty strings');
    }
    const nonce = randomBytes(4).toString('hex');
    const result = await this.api.call<{ message_id: number }>('sendMessage', {
      chat_id,
      text: args.text,
      ...(args.parse_mode === undefined ? {} : { parse_mode: args.parse_mode }),
      ...(args.reply_to === undefined ? {} : { reply_parameters: { message_id: args.reply_to } }),
      reply_markup: { inline_keyboard: inlineKeyboard(options, nonce) },
    });
    const pending = await this.loadPending();
    pending[pendingKey(chat_id, result.message_id)] = {
      correlation_id: args.correlation_id ?? null,
      options,
      nonce,
      chat_id,
      asked_at: new Date().toISOString(),
    };
    await this.savePending(pending);
    return { message_id: result.message_id, chat_id, options };
  }

  /** Runs the long-poll loop until `stop()`; every failure is logged and backed off, never thrown. */
  async start(): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    while (!this.stopped) {
      try {
        await this.pollOnce();
        backoff = BACKOFF_MIN_MS;
      } catch (err) {
        const wait =
          err instanceof TelegramError && err.retryAfter !== undefined
            ? err.retryAfter * 1000
            : backoff;
        this.log(
          `chat: poll failed: ${err instanceof Error ? err.message : String(err)}; retrying in ${String(wait / 1000)}s`,
        );
        await this.sleepFn(wait);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * One `getUpdates` round: handles each update in order and persists `offset` after each,
   * so a crash mid-batch replays at most one update (whose events are deduplicated anyway).
   * Returns the number of updates received.
   */
  async pollOnce(): Promise<number> {
    const offset = await this.loadOffset();
    const updates = await this.api.call<TgUpdate[]>(
      'getUpdates',
      {
        ...(offset === undefined ? {} : { offset }),
        timeout: this.config.poll_timeout,
        allowed_updates: ['message', 'channel_post', 'callback_query'],
      },
      { timeoutMs: this.config.timeout + this.config.poll_timeout * 1000 },
    );
    for (const update of updates) {
      try {
        await this.handleUpdate(update);
      } catch (err) {
        const attempts =
          this.failing?.update_id === update.update_id ? this.failing.attempts + 1 : 1;
        this.failing = { update_id: update.update_id, attempts };
        const message = err instanceof Error ? err.message : String(err);
        if (attempts < MAX_UPDATE_ATTEMPTS) {
          // Leave the offset where it is: the next poll delivers this update again.
          throw new Error(
            `update ${String(update.update_id)} failed (attempt ${String(attempts)}): ${message}`,
            { cause: err },
          );
        }
        this.log(
          `chat: giving up on update ${String(update.update_id)} after ${String(attempts)} attempts: ${message}`,
        );
      }
      this.failing = undefined;
      await this.setOffset(update.update_id + 1);
    }
    return updates.length;
  }

  /** Routes one update; exported for tests and for the poll loop. */
  async handleUpdate(update: TgUpdate): Promise<void> {
    const incoming = classifyUpdate(update);
    if (incoming.kind === 'ignored') {
      return;
    }
    if (!this.allowed.has(incoming.chat_id)) {
      if (!this.ignoredChats.has(incoming.chat_id)) {
        this.ignoredChats.add(incoming.chat_id);
        this.log(
          `chat: ignoring ${incoming.kind} from chat ${incoming.chat_id} (not chat_id or allowed_chat_ids)`,
        );
      }
      return;
    }
    if (incoming.kind === 'callback') {
      await this.handleCallback(incoming);
      return;
    }
    if (incoming.reply_to !== null) {
      const pending = await this.loadPending();
      const key = pendingKey(incoming.chat_id, incoming.reply_to);
      const question = pending[key];
      const choice =
        question === undefined ? undefined : matchOption(incoming.text, question.options);
      if (question !== undefined && choice !== undefined) {
        await this.answer(pending, key, question, choice, {
          text: incoming.text,
          from: incoming.from,
          answer_message_id: incoming.message_id,
        });
        return;
      }
    }
    const payload: ChatMessagePayload = {
      text: incoming.text,
      from: incoming.from,
      message_id: incoming.message_id,
      chat_id: incoming.chat_id,
      date: incoming.date,
      reply_to: incoming.reply_to,
    };
    await this.core.emitEvent({
      type: 'chat.message',
      dedup_key: `chat:message:${incoming.chat_id}:${String(incoming.message_id)}`,
      payload: payload as JsonValue,
    });
  }

  private async handleCallback(
    incoming: Extract<ReturnType<typeof classifyUpdate>, { kind: 'callback' }>,
  ): Promise<void> {
    const pending = await this.loadPending();
    const key = pendingKey(incoming.chat_id, incoming.message_id);
    const question = pending[key];
    const choice = chosenOption(question, decodeCallback(incoming.data));
    if (question === undefined || choice === undefined) {
      await this.ack(incoming.query_id, 'This question has already been answered.');
      return;
    }
    await this.answer(pending, key, question, choice, {
      text: choice,
      from: incoming.from,
      answer_message_id: null,
    });
    await this.ack(incoming.query_id, `Recorded: ${choice}`);
    try {
      await this.api.call('editMessageReplyMarkup', {
        chat_id: incoming.chat_id,
        message_id: incoming.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      this.log(
        `chat: could not remove the buttons: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async answer(
    pending: PendingMap,
    key: string,
    question: Pending,
    choice: string,
    answer: { text: string; from: From; answer_message_id: number | null },
  ): Promise<void> {
    const [, messageId] = splitKey(key);
    const payload: ChatReplyPayload = {
      correlation_id: question.correlation_id,
      approved: question.options[0] === choice,
      choice,
      text: answer.text,
      from: answer.from,
      message_id: messageId,
      chat_id: question.chat_id,
      answer_message_id: answer.answer_message_id,
    };
    await this.core.emitEvent({
      type: 'chat.reply',
      ...(question.correlation_id === null ? {} : { correlation_id: question.correlation_id }),
      dedup_key: `chat:reply:${question.chat_id}:${String(messageId)}`,
      payload: payload as JsonValue,
    });
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete pending[key];
    await this.savePending(pending);
    this.log(`chat: question ${String(messageId)} answered: ${choice}`);
  }

  private async ack(queryId: string, text: string): Promise<void> {
    try {
      await this.api.call('answerCallbackQuery', { callback_query_id: queryId, text });
    } catch (err) {
      this.log(
        `chat: answerCallbackQuery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private targetChat(chatId: string | number | undefined): string {
    if (chatId === undefined) {
      return this.config.chat_id;
    }
    const id = String(chatId);
    if (!this.allowed.has(id)) {
      throw new Error('chat_id is not the configured chat_id or one of allowed_chat_ids');
    }
    return id;
  }

  private async loadOffset(): Promise<number | undefined> {
    if (this.offsetLoaded) {
      return this.offset;
    }
    const stored = await this.core.getState(STATE_OFFSET);
    if (typeof stored === 'number') {
      this.offset = stored;
    } else if (this.config.initial === 'none') {
      // No cursor yet: skip whatever Telegram kept for us while nobody was polling.
      const last = await this.api.call<TgUpdate[]>('getUpdates', { offset: -1, timeout: 0 });
      const newest = last[last.length - 1];
      if (newest !== undefined) {
        await this.setOffset(newest.update_id + 1);
        this.log(`chat: skipped the update backlog up to ${String(newest.update_id)}`);
      }
    }
    this.offsetLoaded = true;
    return this.offset;
  }

  private async setOffset(offset: number): Promise<void> {
    this.offset = offset;
    await this.core.putState(STATE_OFFSET, offset);
  }

  private async loadPending(): Promise<PendingMap> {
    const stored = await this.core.getState(STATE_PENDING);
    return stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as PendingMap)
      : {};
  }

  private async savePending(pending: PendingMap): Promise<void> {
    const keys = Object.keys(pending);
    if (keys.length > this.config.pending_limit) {
      keys
        .sort((a, b) => (pending[a]?.asked_at ?? '').localeCompare(pending[b]?.asked_at ?? ''))
        .slice(0, keys.length - this.config.pending_limit)
        .forEach((k) => {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete pending[k];
        });
    }
    await this.core.putState(STATE_PENDING, pending);
  }
}

/** The option a button tap names, when the tap belongs to this (still open) question. */
function chosenOption(
  question: Pending | undefined,
  decoded: { nonce: string; index: number } | undefined,
): string | undefined {
  if (question === undefined || decoded === undefined) {
    return undefined;
  }
  if (question.nonce !== decoded.nonce) {
    return undefined;
  }
  return question.options[decoded.index];
}

function pendingKey(chatId: string, messageId: number): string {
  return `${chatId}:${String(messageId)}`;
}

function splitKey(key: string): [string, number] {
  const at = key.lastIndexOf(':');
  return [key.slice(0, at), Number(key.slice(at + 1))];
}

/** The bot's own identity, for the startup log line (never the token). */
export async function whoAmI(api: TelegramApi): Promise<string> {
  const me = await api.call<TgUser>('getMe');
  return me.username === undefined ? me.first_name : `@${me.username}`;
}
