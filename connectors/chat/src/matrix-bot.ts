/**
 * The Matrix backend: the same `send` and `ask` ops and the same `chat.message` and
 * `chat.reply` events as the Telegram bot, over the Client-Server API.
 *
 * Matrix has no inline buttons, so `ask` lists the options with a keycap each (1️⃣ 2️⃣ …)
 * and reacts to its own question with those keycaps: tapping one is the answer. A reply to
 * the question naming an option (its text, its number or its keycap) answers too.
 *
 * All state lives in the core so a restart neither replays the timeline nor forgets which
 * question a reaction belongs to: `since` (the `/sync` token) and `pending` (question event
 * id → correlation id and options). Encrypted rooms are not supported: the bot sees only
 * `m.room.encrypted` there, which it reports once per room and otherwise ignores.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { JsonValue } from '@247-agent/connector-sdk';

import {
  loadPendingState,
  savePendingState,
  STATE_PENDING,
  type AskArgs,
  type CoreLike,
  type SendArgs,
  type SentMessage,
} from './bot.js';
import { allowedChats, type MatrixConfig } from './config.js';
import { MatrixError, seg, type MatrixApi } from './matrix.js';
import type { ChatMessagePayload, ChatReplyPayload, From } from './types.js';
import { matchOption } from './updates.js';

export const STATE_SINCE = 'since';
export { STATE_PENDING };

/** Reaction keys for options 1..10, in order. */
export const OPTION_KEYS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
/** `OPTION_KEYS` without the variation selector, for matching what clients send. */
const OPTION_KEYS_NORMALIZED = OPTION_KEYS.map(normalizeKey);

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** A poison event is skipped after this many failed attempts. */
const MAX_EVENT_ATTEMPTS = 3;
const TIMELINE_LIMIT = 50;

export interface MxEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

export interface MxSync {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: MxEvent[]; limited?: boolean } } | undefined>;
  };
}

interface Pending {
  correlation_id: string | null;
  options: string[];
  chat_id: string;
  asked_at: string;
  [key: string]: JsonValue;
}

/** Question event id → the open question. */
type PendingMap = Record<string, Pending>;

interface Relation {
  rel_type?: string;
  event_id?: string;
  key?: string;
  /** On a thread relation: `m.in_reply_to` is only the fallback for thread-unaware clients. */
  is_falling_back?: boolean;
  'm.in_reply_to'?: { event_id?: string };
}

export class MatrixBot {
  private me = '';
  /** Configured alias or id → room id, filled by `init`. */
  private readonly rooms = new Map<string, string>();
  private readonly allowed = new Set<string>();
  private since: string | undefined;
  private sinceLoaded = false;
  private stopped = false;
  /** Events of the batch being handled, so a retried batch does not handle one twice. */
  private readonly handled = new Set<string>();
  private failing: { event_id: string; attempts: number } | undefined;
  private readonly names = new Map<string, string>();
  private readonly warnedEncrypted = new Set<string>();
  /** Serialises read-modify-write of `pending` between `ask` and the sync loop. */
  private pendingLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: MatrixConfig,
    private readonly api: MatrixApi,
    private readonly core: CoreLike,
    private readonly log: (line: string) => void,
    private readonly sleepFn: (ms: number) => Promise<void> = (ms) => sleep(ms),
  ) {}

  /**
   * Who the bot is, and joins every configured room (a no-op when already joined), which
   * also resolves aliases. Throws on a bad token or a room the bot cannot join.
   */
  async init(): Promise<string> {
    const who = await this.api.call<{ user_id: string }>('GET', '/account/whoami');
    this.me = who.user_id;
    for (const room of allowedChats(this.config)) {
      const joined = await this.api.call<{ room_id: string }>('POST', `/join/${seg(room)}`, {
        body: {},
      });
      this.rooms.set(room, joined.room_id);
      this.rooms.set(joined.room_id, joined.room_id);
      this.allowed.add(joined.room_id);
    }
    return this.me;
  }

  /** Posts a message; `reply_to` (an event id) quotes an earlier message of the same room. */
  async send(args: SendArgs): Promise<SentMessage> {
    const room = this.targetRoom(args.chat_id);
    const content = messageContent(args.text, args.parse_mode, 'm.text');
    const replyTo = replyTarget(args.reply_to);
    if (replyTo !== undefined) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo } };
    }
    const eventId = await this.sendEvent(room, 'm.room.message', content);
    return { message_id: eventId, chat_id: room };
  }

  /**
   * Posts a question listing the options with a keycap each, reacts to it with those keycaps
   * and remembers it in state, so a tap on a keycap (or a reply naming an option) becomes
   * a `chat.reply` carrying `correlation_id`.
   */
  async ask(args: AskArgs): Promise<SentMessage & { options: string[] }> {
    const room = this.targetRoom(args.chat_id);
    const options = (args.options ?? this.config.ask_options).map((o) => o.trim());
    if (options.length === 0 || options.some((o) => o === '')) {
      throw new Error('ask: options must be non-empty strings');
    }
    if (options.length > OPTION_KEYS.length) {
      throw new Error(`ask: Matrix questions take at most ${String(OPTION_KEYS.length)} options`);
    }
    const listing = options.map((o, i) => `${OPTION_KEYS[i] ?? ''} ${o}`).join('\n');
    const hint = 'React with an option, or reply with its text.';
    const plain = `${args.text}\n\n${listing}\n${hint}`;
    const content: Record<string, unknown> =
      args.parse_mode === 'HTML'
        ? {
            msgtype: 'm.text',
            body: `${stripTags(args.text)}\n\n${listing}\n${hint}`,
            format: 'org.matrix.custom.html',
            formatted_body: `${args.text}<br><br>${options
              .map((o, i) => `${OPTION_KEYS[i] ?? ''} ${escapeHtml(o)}`)
              .join('<br>')}<br><i>${hint}</i>`,
          }
        : { msgtype: 'm.text', body: plain };
    const replyTo = replyTarget(args.reply_to);
    if (replyTo !== undefined) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo } };
    }
    const eventId = await this.sendEvent(room, 'm.room.message', content);
    await this.withPending(async (pending) => {
      pending[eventId] = {
        correlation_id: args.correlation_id ?? null,
        options,
        chat_id: room,
        asked_at: new Date().toISOString(),
      };
      await this.savePending(pending);
    });
    for (const key of OPTION_KEYS.slice(0, options.length)) {
      try {
        await this.sendEvent(room, 'm.reaction', {
          'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
        });
      } catch (err) {
        this.log(`chat: could not add the ${key} reaction: ${errorText(err)}`);
      }
    }
    return { message_id: eventId, chat_id: room, options };
  }

  /** Runs the sync loop until `stop()`; every failure is logged and backed off, never thrown. */
  async start(): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    while (!this.stopped) {
      try {
        await this.pollOnce();
        backoff = BACKOFF_MIN_MS;
      } catch (err) {
        const wait =
          err instanceof MatrixError && err.retryAfterMs !== undefined ? err.retryAfterMs : backoff;
        this.log(`chat: sync failed: ${errorText(err)}; retrying in ${String(wait / 1000)}s`);
        await this.sleepFn(wait);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * One `/sync` round: handles every timeline event of the allowed rooms in order, then
   * persists `since`. A failure leaves `since` where it was, so the next round delivers the
   * batch again; events already handled in this process are skipped, the rest are
   * deduplicated by the core. Returns the number of events received.
   */
  async pollOnce(): Promise<number> {
    const since = await this.loadSince();
    const sync = await this.api.call<MxSync>('GET', '/sync', {
      query: {
        ...(since === undefined ? {} : { since }),
        timeout: this.config.poll_timeout * 1000,
        filter: this.filter(TIMELINE_LIMIT),
      },
      timeoutMs: this.config.timeout + this.config.poll_timeout * 1000,
    });
    let count = 0;
    for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
      if (room?.timeline?.limited === true && since !== undefined) {
        this.log(
          `chat: room ${roomId} had more than ${String(TIMELINE_LIMIT)} new events; older ones were skipped`,
        );
      }
      for (const event of room?.timeline?.events ?? []) {
        count++;
        if (this.handled.has(event.event_id)) {
          continue;
        }
        try {
          await this.handleEvent(roomId, event);
        } catch (err) {
          const attempts =
            this.failing?.event_id === event.event_id ? this.failing.attempts + 1 : 1;
          this.failing = { event_id: event.event_id, attempts };
          if (attempts < MAX_EVENT_ATTEMPTS) {
            throw new Error(
              `event ${event.event_id} failed (attempt ${String(attempts)}): ${errorText(err)}`,
              { cause: err },
            );
          }
          this.log(
            `chat: giving up on event ${event.event_id} after ${String(attempts)} attempts: ${errorText(err)}`,
          );
        }
        this.failing = undefined;
        this.handled.add(event.event_id);
      }
    }
    await this.setSince(sync.next_batch);
    this.handled.clear();
    return count;
  }

  /** Routes one timeline event; exported for tests and for the sync loop. */
  async handleEvent(roomId: string, event: MxEvent): Promise<void> {
    if (!this.allowed.has(roomId) || event.sender === this.me) {
      return;
    }
    if (event.type === 'm.room.encrypted') {
      if (!this.warnedEncrypted.has(roomId)) {
        this.warnedEncrypted.add(roomId);
        this.log(
          `chat: room ${roomId} is encrypted; the Matrix backend reads unencrypted rooms only, its messages are ignored`,
        );
      }
      return;
    }
    const relation = event.content['m.relates_to'] as Relation | undefined;
    if (event.type === 'm.reaction') {
      if (relation?.rel_type === 'm.annotation' && relation.event_id !== undefined) {
        await this.handleReaction(event, relation.event_id, relation.key ?? '');
      }
      return;
    }
    if (event.type !== 'm.room.message') {
      return;
    }
    const msgtype = event.content.msgtype;
    const body = event.content.body;
    if ((msgtype !== 'm.text' && msgtype !== 'm.emote') || typeof body !== 'string') {
      return;
    }
    if (relation?.rel_type === 'm.replace') {
      return; // an edit; Telegram's edited messages are ignored too
    }
    const text = stripReplyFallback(body);
    const thread = relation?.rel_type === 'm.thread' ? relation.event_id : undefined;
    // In a thread, `m.in_reply_to` with `is_falling_back` points at the thread's latest
    // event, not at what the user answered: the thread root is the question then.
    const inReplyTo =
      thread !== undefined && relation?.is_falling_back === true
        ? undefined
        : relation?.['m.in_reply_to']?.event_id;
    const replyTo = inReplyTo ?? thread ?? null;
    const from = await this.fromOf(event.sender);
    const candidates = [replyTo, thread].filter(
      (id): id is string => id !== null && id !== undefined,
    );
    if (candidates.length > 0) {
      const answered = await this.withPending(async (pending) => {
        for (const questionId of candidates) {
          const question = pending[questionId];
          const choice = question === undefined ? undefined : matchAnswer(text, question.options);
          if (question !== undefined && choice !== undefined) {
            await this.answer(pending, questionId, question, choice, {
              text,
              from,
              answer_message_id: event.event_id,
            });
            return { questionId, chat_id: question.chat_id, choice };
          }
        }
        return undefined;
      });
      if (answered !== undefined) {
        await this.confirm(answered.chat_id, answered.questionId, answered.choice);
        return;
      }
    }
    const payload: ChatMessagePayload = {
      text,
      from,
      message_id: event.event_id,
      chat_id: roomId,
      date: new Date(event.origin_server_ts).toISOString(),
      reply_to: replyTo,
    };
    await this.core.emitEvent({
      type: 'chat.message',
      dedup_key: `chat:message:${roomId}:${event.event_id}`,
      payload: payload as JsonValue,
    });
  }

  private async handleReaction(event: MxEvent, questionId: string, key: string): Promise<void> {
    const answered = await this.withPending(async (pending) => {
      const question = pending[questionId];
      if (question === undefined) {
        return undefined; // a reaction to anything else, or to a question already answered
      }
      const choice = question.options[OPTION_KEYS_NORMALIZED.indexOf(normalizeKey(key))];
      if (choice === undefined) {
        return undefined;
      }
      await this.answer(pending, questionId, question, choice, {
        text: choice,
        from: await this.fromOf(event.sender),
        answer_message_id: null,
      });
      return { chat_id: question.chat_id, choice };
    });
    if (answered !== undefined) {
      await this.confirm(answered.chat_id, questionId, answered.choice);
    }
  }

  private async answer(
    pending: PendingMap,
    questionId: string,
    question: Pending,
    choice: string,
    answer: { text: string; from: From; answer_message_id: string | null },
  ): Promise<void> {
    const payload: ChatReplyPayload = {
      correlation_id: question.correlation_id,
      approved: question.options[0] === choice,
      choice,
      text: answer.text,
      from: answer.from,
      message_id: questionId,
      chat_id: question.chat_id,
      answer_message_id: answer.answer_message_id,
    };
    await this.core.emitEvent({
      type: 'chat.reply',
      ...(question.correlation_id === null ? {} : { correlation_id: question.correlation_id }),
      dedup_key: `chat:reply:${question.chat_id}:${questionId}`,
      payload: payload as JsonValue,
    });
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete pending[questionId];
    await this.savePending(pending);
    this.log(`chat: question ${questionId} answered: ${choice}`);
  }

  /** The `Recorded: <choice>` notice in reply to an answered question; best effort. */
  private async confirm(room: string, questionId: string, choice: string): Promise<void> {
    try {
      await this.sendEvent(room, 'm.room.message', {
        msgtype: 'm.notice',
        body: `Recorded: ${choice}`,
        'm.relates_to': { 'm.in_reply_to': { event_id: questionId } },
      });
    } catch (err) {
      this.log(`chat: could not confirm the answer: ${errorText(err)}`);
    }
  }

  /** Runs `fn` on the stored questions, one caller at a time, so no save loses another's change. */
  private withPending<T>(fn: (pending: PendingMap) => Promise<T>): Promise<T> {
    const run = this.pendingLock.then(async () => fn(await loadPendingState<Pending>(this.core)));
    this.pendingLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendEvent(
    room: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const txn = `oa${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
    const r = await this.api.call<{ event_id: string }>(
      'PUT',
      `/rooms/${seg(room)}/send/${seg(type)}/${txn}`,
      { body: content },
    );
    return r.event_id;
  }

  private targetRoom(chatId: string | number | undefined): string {
    const wanted = chatId === undefined ? this.config.chat_id : String(chatId);
    const room = this.rooms.get(wanted);
    if (room === undefined) {
      throw new Error(
        chatId === undefined
          ? 'chat: the connector has not joined its room yet'
          : 'chat_id is not the configured chat_id or one of allowed_chat_ids',
      );
    }
    return room;
  }

  /** The sync filter: the allowed rooms' messages and reactions, nothing else. */
  private filter(limit: number): string {
    return JSON.stringify({
      presence: { types: [] },
      account_data: { types: [] },
      room: {
        rooms: [...this.allowed],
        timeline: { types: ['m.room.message', 'm.reaction', 'm.room.encrypted'], limit },
        state: { types: [] },
        ephemeral: { types: [] },
        account_data: { types: [] },
      },
    });
  }

  /** `{ id, name, username }`: the user id, their display name (cached), the user id. */
  private async fromOf(userId: string): Promise<From> {
    let name = this.names.get(userId);
    if (name === undefined) {
      try {
        const profile = await this.api.call<{ displayname?: string }>(
          'GET',
          `/profile/${seg(userId)}/displayname`,
        );
        name = profile.displayname ?? localpart(userId);
        this.names.set(userId, name);
      } catch {
        // Not cached: a transient failure should not pin the fallback name for good.
        name = localpart(userId);
      }
    }
    return { id: userId, name, username: userId };
  }

  private async loadSince(): Promise<string | undefined> {
    if (this.sinceLoaded) {
      return this.since;
    }
    const stored = await this.core.getState(STATE_SINCE);
    if (typeof stored === 'string') {
      this.since = stored;
    } else if (this.config.initial === 'none') {
      // No cursor yet: start from now, without what the rooms said before the bot existed.
      const first = await this.api.call<MxSync>('GET', '/sync', {
        query: { timeout: 0, filter: this.filter(1) },
      });
      await this.setSince(first.next_batch);
      this.log('chat: skipped the room history up to now');
    }
    this.sinceLoaded = true;
    return this.since;
  }

  private async setSince(since: string): Promise<void> {
    this.since = since;
    await this.core.putState(STATE_SINCE, since);
  }

  private async savePending(pending: PendingMap): Promise<void> {
    await savePendingState(this.core, pending, this.config.pending_limit);
  }
}

/** The option a typed answer names: its text (as on Telegram), its number, or its keycap. */
export function matchAnswer(text: string, options: string[]): string | undefined {
  const byText = matchOption(text, options);
  if (byText !== undefined) {
    return byText;
  }
  const wanted = text.trim();
  if (/^\d{1,2}$/.test(wanted)) {
    return options[Number(wanted) - 1];
  }
  const index = OPTION_KEYS_NORMALIZED.indexOf(normalizeKey(wanted));
  return index < 0 ? undefined : options[index];
}

/** Keycaps arrive with or without the emoji variation selector; compare without it. */
function normalizeKey(key: string): string {
  return key.replace(/\uFE0F/g, '').trim();
}

/**
 * The reply fallback some clients still put in front of a reply's body (`> <@a:b> quoted`
 * lines, then a blank line) is not part of what the user typed.
 */
export function stripReplyFallback(body: string): string {
  return body.replace(/^(?:>[^\n]*\n)+\n/, '');
}

function messageContent(
  text: string,
  parseMode: SendArgs['parse_mode'],
  msgtype: string,
): Record<string, unknown> {
  if (parseMode === 'HTML') {
    return {
      msgtype,
      body: stripTags(text),
      format: 'org.matrix.custom.html',
      formatted_body: text,
    };
  }
  // Markdown is sent as typed: Matrix clients show `body` verbatim.
  return { msgtype, body: text };
}

function replyTarget(replyTo: SendArgs['reply_to']): string | undefined {
  if (replyTo === undefined) {
    return undefined;
  }
  if (typeof replyTo !== 'string' || !replyTo.startsWith('$')) {
    throw new Error('reply_to must be a Matrix event id ($…) on the matrix backend');
  }
  return replyTo;
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function localpart(userId: string): string {
  return userId.replace(/^@/, '').split(':')[0] ?? userId;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
