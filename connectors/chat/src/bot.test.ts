import { describe, expect, it } from 'vitest';

import { ChatBot, STATE_OFFSET, STATE_PENDING, whoAmI } from './bot.js';
import { TelegramError } from './telegram.js';
import {
  buttonData,
  callbackUpdate,
  config,
  FakeCore,
  FakeTelegram,
  messageUpdate,
  TOKEN,
} from './test-helpers.js';
import type { TgUpdate } from './types.js';

function setup(overrides: Record<string, unknown> = {}) {
  const cfg = config(overrides);
  const tg = new FakeTelegram(cfg);
  const core = new FakeCore();
  const lines: string[] = [];
  const sleeps: number[] = [];
  const bot = new ChatBot(
    cfg,
    tg.api,
    core,
    (l) => lines.push(l),
    (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  );
  return { cfg, tg, core, lines, sleeps, bot };
}

describe('send', () => {
  it('posts to the configured chat and returns the message id', async () => {
    const { tg, bot } = setup();
    const sent = await bot.send({ text: 'hi', parse_mode: 'HTML', reply_to: 3 });
    expect(sent).toEqual({ message_id: 100, chat_id: '42' });
    expect(tg.of('sendMessage')[0]?.params).toEqual({
      chat_id: '42',
      text: 'hi',
      parse_mode: 'HTML',
      reply_parameters: { message_id: 3 },
    });
  });

  it('accepts an allowed chat id and refuses any other', async () => {
    const { tg, bot } = setup({ allowed_chat_ids: [43] });
    await bot.send({ text: 'x', chat_id: 43 });
    expect(tg.of('sendMessage')[0]?.params.chat_id).toBe('43');
    await expect(bot.send({ text: 'x', chat_id: 44 })).rejects.toThrow(/not the configured/);
  });

  it('surfaces Telegram errors without the token', async () => {
    const { tg, bot } = setup();
    tg.failNext('sendMessage', 400, 'Bad Request: chat not found');
    const err = await bot.send({ text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).code).toBe(400);
    expect((err as Error).message).toBe('sendMessage: Bad Request: chat not found (400)');
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe('ask and reply', () => {
  it('sends the default buttons and remembers the question in state', async () => {
    const { tg, core, bot } = setup();
    const asked = await bot.ask({ text: 'Deploy?', correlation_id: 'cor_1' });
    expect(asked).toEqual({ message_id: 100, chat_id: '42', options: ['Approve', 'Reject'] });
    const params = tg.of('sendMessage')[0]?.params as {
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    const [row] = params.reply_markup.inline_keyboard;
    expect(row?.map((b) => b.text)).toEqual(['Approve', 'Reject']);
    expect(row?.[0]?.callback_data).toMatch(/^oa:[0-9a-f]{8}:0$/);
    expect(core.state.get(STATE_PENDING)).toEqual({
      '42:100': {
        correlation_id: 'cor_1',
        options: ['Approve', 'Reject'],
        nonce: expect.stringMatching(/^[0-9a-f]{8}$/) as string,
        chat_id: '42',
        asked_at: expect.any(String) as string,
      },
    });
  });

  it('emits chat.reply with the correlation id when a button is tapped, once', async () => {
    const { tg, core, bot } = setup();
    const asked = await bot.ask({ text: 'Deploy?', correlation_id: 'cor_1' });
    const data = buttonData(tg);

    await bot.handleUpdate(callbackUpdate(data, { message_id: asked.message_id, query_id: 'q1' }));
    expect(core.events).toEqual([
      {
        type: 'chat.reply',
        correlation_id: 'cor_1',
        dedup_key: 'chat:reply:42:100',
        payload: {
          correlation_id: 'cor_1',
          approved: true,
          choice: 'Approve',
          text: 'Approve',
          from: { id: 7, name: 'Miro', username: 'miro' },
          message_id: 100,
          chat_id: '42',
          answer_message_id: null,
        },
      },
    ]);
    expect(core.state.get(STATE_PENDING)).toEqual({});
    expect(tg.of('answerCallbackQuery')[0]?.params).toEqual({
      callback_query_id: 'q1',
      text: 'Recorded: Approve',
    });
    expect(tg.of('editMessageReplyMarkup')[0]?.params).toMatchObject({
      chat_id: '42',
      message_id: 100,
      reply_markup: { inline_keyboard: [] },
    });

    // A second tap on the same (now answered) question only gets an acknowledgement.
    await bot.handleUpdate(callbackUpdate(data, { message_id: asked.message_id, query_id: 'q2' }));
    expect(core.events).toHaveLength(1);
    expect(tg.of('answerCallbackQuery')[1]?.params).toMatchObject({
      callback_query_id: 'q2',
      text: expect.stringContaining('already') as string,
    });
  });

  it('treats any option but the first as not approved and honours custom options', async () => {
    const { tg, core, bot } = setup();
    const asked = await bot.ask({
      text: 'Which?',
      correlation_id: 'cor_2',
      options: ['Now', 'Later', 'Never'],
    });
    await bot.handleUpdate(callbackUpdate(buttonData(tg, 2), { message_id: asked.message_id }));
    expect(core.events[0]?.payload).toMatchObject({
      approved: false,
      choice: 'Never',
      correlation_id: 'cor_2',
    });
  });

  it('accepts a text reply naming an option, and relays other replies as messages', async () => {
    const { core, bot } = setup();
    const asked = await bot.ask({ text: 'Deploy?', correlation_id: 'cor_3' });
    await bot.handleUpdate(messageUpdate('why?', { message_id: 200, reply_to: asked.message_id }));
    expect(core.ofType('chat.message')).toHaveLength(1);
    expect(core.ofType('chat.message')[0]?.payload).toMatchObject({ text: 'why?', reply_to: 100 });
    expect(core.ofType('chat.reply')).toHaveLength(0);

    await bot.handleUpdate(
      messageUpdate(' reject ', { message_id: 201, reply_to: asked.message_id }),
    );
    expect(core.ofType('chat.reply')[0]).toMatchObject({
      correlation_id: 'cor_3',
      dedup_key: 'chat:reply:42:100',
      payload: {
        approved: false,
        choice: 'Reject',
        text: ' reject ',
        message_id: 100,
        answer_message_id: 201,
      },
    });
    expect(core.state.get(STATE_PENDING)).toEqual({});
  });

  it('rejects a forged callback whose nonce does not match', async () => {
    const { tg, core, bot } = setup();
    const asked = await bot.ask({ text: 'Deploy?', correlation_id: 'cor_4' });
    await bot.handleUpdate(callbackUpdate('oa:00000000:0', { message_id: asked.message_id }));
    expect(core.events).toHaveLength(0);
    expect(tg.of('answerCallbackQuery')).toHaveLength(1);
  });

  it('keeps only the newest pending_limit questions', async () => {
    const { core, bot } = setup({ pending_limit: 2 });
    await bot.ask({ text: 'a' });
    await bot.ask({ text: 'b' });
    await bot.ask({ text: 'c' });
    expect(Object.keys(core.state.get(STATE_PENDING) as object)).toEqual(['42:101', '42:102']);
  });

  it('omits the event correlation id when ask had none', async () => {
    const { tg, core, bot } = setup();
    const asked = await bot.ask({ text: 'Deploy?' });
    await bot.handleUpdate(callbackUpdate(buttonData(tg), { message_id: asked.message_id }));
    expect(core.events[0]).not.toHaveProperty('correlation_id');
    expect(core.events[0]?.payload).toMatchObject({ correlation_id: null, approved: true });
  });
});

describe('messages', () => {
  it('emits chat.message for the configured chat with a dedup key', async () => {
    const { core, bot } = setup();
    await bot.handleUpdate(messageUpdate('hello', { message_id: 9 }));
    expect(core.events).toEqual([
      {
        type: 'chat.message',
        dedup_key: 'chat:message:42:9',
        payload: {
          text: 'hello',
          from: { id: 7, name: 'Miro P', username: 'miro' },
          message_id: 9,
          chat_id: '42',
          date: '2023-11-14T22:13:20.000Z',
          reply_to: null,
        },
      },
    ]);
  });

  it('ignores other chats and logs each of them once', async () => {
    const { core, lines, bot } = setup({ allowed_chat_ids: [43] });
    await bot.handleUpdate(messageUpdate('spam', { chat_id: 99 }));
    await bot.handleUpdate(messageUpdate('more spam', { chat_id: 99 }));
    await bot.handleUpdate(callbackUpdate('oa:x:0', { chat_id: 99, message_id: 1 }));
    await bot.handleUpdate(messageUpdate('ok', { chat_id: 43, message_id: 4 }));
    expect(core.events.map((e) => (e.payload as { chat_id: string }).chat_id)).toEqual(['43']);
    expect(lines).toEqual([
      'chat: ignoring message from chat 99 (not chat_id or allowed_chat_ids)',
    ]);
  });
});

describe('polling', () => {
  it('skips the backlog on first start, then persists the offset after each update', async () => {
    const { tg, core, bot } = setup();
    tg.respond('getUpdates', (params) => {
      if (params.offset === -1) {
        return [{ update_id: 41 }];
      }
      return params.offset === 42
        ? [messageUpdate('a', { message_id: 1 }), messageUpdate('b', { message_id: 2 })]
        : [];
    });
    expect(await bot.pollOnce()).toBe(2);
    expect(tg.of('getUpdates').map((c) => c.params)).toEqual([
      { offset: -1, timeout: 0 },
      { offset: 42, timeout: 0, allowed_updates: ['message', 'channel_post', 'callback_query'] },
    ]);
    expect(core.events.map((e) => (e.payload as { text: string }).text)).toEqual(['a', 'b']);
    // The offset is the last handled update's id + 1, written to state.
    const stored = core.state.get(STATE_OFFSET);
    expect(stored).toBeTypeOf('number');
    expect(stored as number).toBeGreaterThan(42);

    // The next poll continues from the stored offset without asking for the backlog again.
    expect(await bot.pollOnce()).toBe(0);
    expect(tg.of('getUpdates')[2]?.params.offset).toBe(stored);
  });

  it('resumes from the offset in state after a restart', async () => {
    const { tg, core, bot } = setup();
    await core.putState(STATE_OFFSET, 777);
    await bot.pollOnce();
    expect(tg.of('getUpdates').map((c) => c.params.offset)).toEqual([777]);
  });

  it('delivers the backlog with initial: all', async () => {
    const { tg, core, bot } = setup({ initial: 'all' });
    tg.updates.push([messageUpdate('old', { message_id: 1 })]);
    await bot.pollOnce();
    expect(tg.of('getUpdates')[0]?.params).not.toHaveProperty('offset');
    expect(core.events).toHaveLength(1);
  });

  it('does not advance past an update whose handling failed, then gives up on it', async () => {
    const { tg, core, lines, bot } = setup();
    await core.putState(STATE_OFFSET, 10);
    const bad: TgUpdate = { ...messageUpdate('boom', { message_id: 1 }), update_id: 10 };
    tg.respond('getUpdates', () => [bad]);
    const emit = core.emitEvent.bind(core);
    core.emitEvent = () => Promise.reject(new Error('core down'));

    await expect(bot.pollOnce()).rejects.toThrow(/update 10 failed \(attempt 1\)/);
    await expect(bot.pollOnce()).rejects.toThrow(/attempt 2/);
    expect(core.state.get(STATE_OFFSET)).toBe(10);
    expect(await bot.pollOnce()).toBe(1);
    expect(core.state.get(STATE_OFFSET)).toBe(11);
    expect(lines.some((l) => l.includes('giving up on update 10'))).toBe(true);
    core.emitEvent = emit;
  });

  it('backs off on poll failures, honours retry_after and recovers', async () => {
    const { tg, core, lines, sleeps, bot } = setup();
    await core.putState(STATE_OFFSET, 1);
    tg.failNext('getUpdates', 502, 'Bad Gateway');
    tg.failNext('getUpdates', 502, 'Bad Gateway');
    tg.failNext('getUpdates', 429, 'Too Many Requests', 7);
    tg.respond('getUpdates', () => {
      bot.stop();
      return [];
    });
    await bot.start();
    expect(sleeps).toEqual([1000, 2000, 7000]);
    expect(lines).toEqual([
      'chat: poll failed: getUpdates: Bad Gateway (502); retrying in 1s',
      'chat: poll failed: getUpdates: Bad Gateway (502); retrying in 2s',
      'chat: poll failed: getUpdates: Too Many Requests (429); retrying in 7s',
    ]);
    expect(tg.of('getUpdates')).toHaveLength(4);
  });
});

describe('whoAmI', () => {
  it('reports the bot username', async () => {
    const { tg } = setup();
    expect(await whoAmI(tg.api)).toBe('@ops_bot');
  });
});
