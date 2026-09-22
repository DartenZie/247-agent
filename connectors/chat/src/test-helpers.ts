/** Fakes for the tests: a Bot API behind `fetch`, and the core's state and event endpoints. */
import type { EmitInput, EmitResult, JsonValue } from '@247-agent/connector-sdk';

import type { CoreLike } from './bot.js';
import { parseConfig, type ChatConfig } from './config.js';
import { createTelegramApi, type TelegramApi } from './telegram.js';
import type { TgMessage, TgUpdate } from './types.js';

export const TOKEN = '123456:secret-token';

export function config(overrides: Record<string, unknown> = {}): ChatConfig {
  return parseConfig({ token: TOKEN, chat_id: 42, poll_timeout: 0, ...overrides });
}

export interface ApiCall {
  method: string;
  params: Record<string, unknown>;
}

type Responder = (params: Record<string, unknown>) => unknown;

interface ApiFailure {
  code: number;
  description: string;
  retry_after?: number;
}

/** A fake Telegram server: records every call, answers from `respond` or a sane default. */
export class FakeTelegram {
  readonly calls: ApiCall[] = [];
  readonly api: TelegramApi;
  /** Batches `getUpdates` hands out, one per call; empty when exhausted. */
  readonly updates: TgUpdate[][] = [];
  private nextMessageId = 100;
  private readonly responders = new Map<string, Responder>();
  private readonly failures = new Map<string, ApiFailure[]>();

  constructor(cfg: ChatConfig = config()) {
    this.api = createTelegramApi({
      token: cfg.token,
      apiBase: cfg.api_base,
      timeoutMs: cfg.timeout,
      fetch: (url, init) => this.handle(url, init),
    });
  }

  respond(method: string, fn: Responder): void {
    this.responders.set(method, fn);
  }

  /** Makes the next call of `method` fail with a Telegram error; queue several for a sequence. */
  failNext(method: string, code: number, description: string, retry_after?: number): void {
    const queue = this.failures.get(method) ?? [];
    queue.push({ code, description, ...(retry_after === undefined ? {} : { retry_after }) });
    this.failures.set(method, queue);
  }

  of(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private handle(url: string, init: RequestInit): Promise<Response> {
    const match = /\/bot([^/]+)\/(\w+)$/.exec(url);
    const method = match?.[2];
    if (match?.[1] !== TOKEN || method === undefined) {
      return Promise.resolve(json({ ok: false, error_code: 401, description: 'Unauthorized' }));
    }
    const body = typeof init.body === 'string' ? init.body : '{}';
    const params = JSON.parse(body) as Record<string, unknown>;
    this.calls.push({ method, params });
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined) {
      return Promise.resolve(
        json({
          ok: false,
          error_code: failure.code,
          description: failure.description,
          ...(failure.retry_after === undefined
            ? {}
            : { parameters: { retry_after: failure.retry_after } }),
        }),
      );
    }
    const responder = this.responders.get(method);
    const result = responder === undefined ? this.defaultResult(method, params) : responder(params);
    return Promise.resolve(json({ ok: true, result }));
  }

  private defaultResult(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'getMe':
        return { id: 1, is_bot: true, first_name: 'Ops', username: 'ops_bot' };
      case 'sendMessage':
        return {
          message_id: this.nextMessageId++,
          date: 1_700_000_000,
          chat: { id: Number(params.chat_id), type: 'private' },
          text: params.text,
        };
      case 'getUpdates':
        return params.offset === -1 ? [] : (this.updates.shift() ?? []);
      default:
        return true;
    }
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** In-memory state and an event list; `emitEvent` honours `dedup_key` like the core. */
export class FakeCore implements CoreLike {
  readonly state = new Map<string, JsonValue>();
  readonly events: EmitInput[] = [];
  private seq = 0;

  emitEvent(input: EmitInput): Promise<EmitResult> {
    if (input.dedup_key !== undefined && this.events.some((e) => e.dedup_key === input.dedup_key)) {
      return Promise.resolve({ status: 'duplicate', dedup_key: input.dedup_key });
    }
    this.events.push(input);
    this.seq += 1;
    return Promise.resolve({
      status: 'inserted',
      event: {
        id: `evt_${String(this.seq)}`,
        correlation_id: input.correlation_id ?? `cor_${String(this.seq)}`,
      },
    });
  }

  getState(key: string): Promise<JsonValue | undefined> {
    return Promise.resolve(this.state.get(key));
  }

  putState(key: string, value: JsonValue): Promise<void> {
    this.state.set(key, structuredClone(value));
    return Promise.resolve();
  }

  ofType(type: string): EmitInput[] {
    return this.events.filter((e) => e.type === type);
  }
}

/** The `callback_data` of button `index` on the last `sendMessage` the fake saw. */
export function buttonData(tg: FakeTelegram, index = 0): string {
  const sends = tg.of('sendMessage');
  const last = sends[sends.length - 1]?.params as
    { reply_markup?: { inline_keyboard: { callback_data: string }[][] } } | undefined;
  const data = last?.reply_markup?.inline_keyboard.flat()[index]?.callback_data;
  if (data === undefined) {
    throw new Error(`no button ${String(index)} on the last sendMessage`);
  }
  return data;
}

let updateId = 1000;

interface MessageOpts {
  chat_id?: number;
  message_id?: number;
  reply_to?: number;
  from?: number;
}

export function message(text: string, opts: MessageOpts = {}): TgMessage {
  const from = opts.from ?? 7;
  updateId += 1;
  return {
    message_id: opts.message_id ?? 500 + updateId,
    date: 1_700_000_000,
    chat: { id: opts.chat_id ?? 42, type: 'private' },
    from: { id: from, first_name: 'Miro', last_name: 'P', username: 'miro' },
    text,
    ...(opts.reply_to === undefined
      ? {}
      : {
          reply_to_message: {
            message_id: opts.reply_to,
            date: 1_699_999_000,
            chat: { id: opts.chat_id ?? 42, type: 'private' as const },
          },
        }),
  };
}

export function messageUpdate(text: string, opts: MessageOpts = {}): TgUpdate {
  return { update_id: updateId++, message: message(text, opts) };
}

export function callbackUpdate(
  data: string,
  opts: { chat_id?: number; message_id: number; query_id?: string },
): TgUpdate {
  return {
    update_id: updateId++,
    callback_query: {
      id: opts.query_id ?? 'q1',
      from: { id: 7, first_name: 'Miro', username: 'miro' },
      data,
      message: { message_id: opts.message_id, chat: { id: opts.chat_id ?? 42, type: 'private' } },
    },
  };
}
