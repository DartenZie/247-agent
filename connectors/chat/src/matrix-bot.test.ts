import { describe, expect, it } from 'vitest';

import { parseConfig, type MatrixConfig } from './config.js';
import { createMatrixApi, MatrixError } from './matrix.js';
import {
  matchAnswer,
  MatrixBot,
  OPTION_KEYS,
  STATE_PENDING,
  STATE_SINCE,
  stripReplyFallback,
  type MxEvent,
  type MxSync,
} from './matrix-bot.js';
import { FakeCore } from './test-helpers.js';

const TOKEN = 'syt_secret';
const ROOM = '!room:example.org';
const OTHER = '!other:example.org';
const ME = '@bot:example.org';

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** A fake homeserver behind the injected fetch: records calls, hands out scripted syncs. */
class FakeMatrix {
  readonly calls: Call[] = [];
  readonly syncs: (MxSync | { status: number; body: unknown })[] = [];
  /** Called on every /sync with the number of syncs so far. */
  onSync: (count: number) => void = () => undefined;
  private eventSeq = 0;
  private batch = 0;

  api(cfg: MatrixConfig) {
    return createMatrixApi({
      homeserver: cfg.homeserver,
      token: cfg.token,
      timeoutMs: cfg.timeout,
      fetch: (url, init) => Promise.resolve(this.handle(url, init)),
    });
  }

  of(method: string, prefix: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(prefix));
  }

  /** Room messages the bot sent, in order. */
  sentMessages(): Call[] {
    return this.of('PUT', `/rooms/${encodeURIComponent(ROOM)}/send/m.room.message/`);
  }

  private handle(url: string, init: RequestInit): Response {
    const u = new URL(url);
    const headers = init.headers as Record<string, string>;
    if (headers.authorization !== `Bearer ${TOKEN}`) {
      return Response.json({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid token' }, { status: 401 });
    }
    const path = u.pathname.replace('/_matrix/client/v3', '');
    const call: Call = {
      method: init.method ?? 'GET',
      path,
      query: Object.fromEntries(u.searchParams),
      body:
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    };
    this.calls.push(call);
    if (path === '/account/whoami') {
      return Response.json({ user_id: ME });
    }
    if (path.startsWith('/join/')) {
      const target = decodeURIComponent(path.slice('/join/'.length));
      return Response.json({ room_id: target.startsWith('#') ? OTHER : target });
    }
    if (path.startsWith('/profile/')) {
      return path.includes('%40ghost')
        ? Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
        : Response.json({ displayname: 'Miro P' });
    }
    if (path.includes('/send/')) {
      this.eventSeq += 1;
      return Response.json({ event_id: `$sent${String(this.eventSeq)}` });
    }
    if (path === '/sync') {
      this.onSync(this.of('GET', '/sync').length);
      const next = this.syncs.shift();
      if (next !== undefined && 'status' in next) {
        return Response.json(next.body, { status: next.status });
      }
      this.batch += 1;
      return Response.json(next ?? { next_batch: `b${String(this.batch)}` });
    }
    return Response.json({ errcode: 'M_UNRECOGNIZED' }, { status: 404 });
  }
}

function config(overrides: Record<string, unknown> = {}): MatrixConfig {
  const c = parseConfig({
    backend: 'matrix',
    homeserver: 'https://matrix.example.org',
    token: TOKEN,
    chat_id: ROOM,
    allowed_chat_ids: ['#ops:example.org'],
    poll_timeout: 0,
    ...overrides,
  });
  if (c.backend !== 'matrix') {
    throw new Error('not a matrix config');
  }
  return c;
}

async function setup(overrides: Record<string, unknown> = {}) {
  const cfg = config(overrides);
  const mx = new FakeMatrix();
  const core = new FakeCore();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const bot = new MatrixBot(
    cfg,
    mx.api(cfg),
    core,
    (l) => logs.push(l),
    (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  );
  await bot.init();
  return { bot, mx, core, logs, sleeps };
}

let seq = 0;
function msg(
  body: string,
  extra: Record<string, unknown> = {},
  sender = '@miro:example.org',
): MxEvent {
  seq += 1;
  return {
    type: 'm.room.message',
    event_id: `$in${String(seq)}`,
    sender,
    origin_server_ts: 1_790_000_000_000,
    content: { msgtype: 'm.text', body, ...extra },
  };
}

function reaction(target: string, key: string, sender = '@miro:example.org'): MxEvent {
  seq += 1;
  return {
    type: 'm.reaction',
    event_id: `$r${String(seq)}`,
    sender,
    origin_server_ts: 1_790_000_000_000,
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key } },
  };
}

function batch(next: string, events: MxEvent[], room = ROOM): MxSync {
  return { next_batch: next, rooms: { join: { [room]: { timeline: { events } } } } };
}

describe('init', () => {
  it('learns who it is and joins every room, resolving aliases', async () => {
    const { mx } = await setup();
    expect(mx.of('POST', '/join/').map((c) => decodeURIComponent(c.path))).toEqual([
      `/join/${ROOM}`,
      '/join/#ops:example.org',
    ]);
  });

  it('fails on a bad token without leaking it', async () => {
    const cfg = config({ token: 'wrong' });
    const bot = new MatrixBot(cfg, new FakeMatrix().api(cfg), new FakeCore(), () => undefined);
    const err = await bot.init().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MatrixError);
    expect((err as MatrixError).errcode).toBe('M_UNKNOWN_TOKEN');
    expect((err as Error).message).toBe('GET /account/whoami: Invalid token (401)');
  });
});

describe('send', () => {
  it('posts to the room, as HTML when asked, quoting reply_to', async () => {
    const { bot, mx } = await setup();
    expect(await bot.send({ text: 'Hello' })).toEqual({ message_id: '$sent1', chat_id: ROOM });
    await bot.send({ text: '<b>Hi</b> &amp; bye', parse_mode: 'HTML', reply_to: '$q' });
    const [plain, html] = mx.sentMessages();
    expect(plain?.body).toEqual({ msgtype: 'm.text', body: 'Hello' });
    expect(html?.body).toEqual({
      msgtype: 'm.text',
      body: 'Hi & bye',
      format: 'org.matrix.custom.html',
      formatted_body: '<b>Hi</b> &amp; bye',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$q' } },
    });
  });

  it('targets allowed rooms by id or alias only, and refuses Telegram ids for reply_to', async () => {
    const { bot } = await setup();
    expect((await bot.send({ text: 'x', chat_id: '#ops:example.org' })).chat_id).toBe(OTHER);
    await expect(bot.send({ text: 'x', chat_id: '!evil:x' })).rejects.toThrow(/not the configured/);
    await expect(bot.send({ text: 'x', reply_to: 12 })).rejects.toThrow(/Matrix event id/);
  });
});

describe('ask → chat.reply', () => {
  it('lists the options, reacts with keycaps and stores the question', async () => {
    const { bot, mx, core } = await setup();
    const asked = await bot.ask({ text: 'Deploy?', correlation_id: 'cor_1' });
    expect(asked).toEqual({ message_id: '$sent1', chat_id: ROOM, options: ['Approve', 'Reject'] });
    expect(mx.sentMessages()[0]?.body).toEqual({
      msgtype: 'm.text',
      body: 'Deploy?\n\n1️⃣ Approve\n2️⃣ Reject\nReact with an option, or reply with its text.',
    });
    const reactions = mx.of('PUT', `/rooms/${encodeURIComponent(ROOM)}/send/m.reaction/`);
    expect(reactions.map((r) => r.body)).toEqual(
      ['1️⃣', '2️⃣'].map((key) => ({
        'm.relates_to': { rel_type: 'm.annotation', event_id: '$sent1', key },
      })),
    );
    expect(core.state.get(STATE_PENDING)).toMatchObject({
      $sent1: { correlation_id: 'cor_1', options: ['Approve', 'Reject'], chat_id: ROOM },
    });
    await expect(
      bot.ask({ text: 'x', options: Array.from({ length: 11 }, (_, i) => `o${String(i)}`) }),
    ).rejects.toThrow(/at most 10/);
  });

  it('turns a keycap reaction into chat.reply once, ignoring its own reactions', async () => {
    const { bot, mx, core } = await setup();
    await bot.ask({ text: 'Deploy?', correlation_id: 'cor_1' });
    await bot.handleEvent(ROOM, reaction('$sent1', '1️⃣', ME));
    expect(core.ofType('chat.reply')).toHaveLength(0);
    await bot.handleEvent(ROOM, reaction('$sent1', '2⃣')); // no variation selector
    const [reply] = core.ofType('chat.reply');
    expect(reply).toEqual({
      type: 'chat.reply',
      correlation_id: 'cor_1',
      dedup_key: `chat:reply:${ROOM}:$sent1`,
      payload: {
        correlation_id: 'cor_1',
        approved: false,
        choice: 'Reject',
        text: 'Reject',
        from: { id: '@miro:example.org', name: 'Miro P', username: '@miro:example.org' },
        message_id: '$sent1',
        chat_id: ROOM,
        answer_message_id: null,
      },
    });
    expect(core.state.get(STATE_PENDING)).toEqual({});
    const notice = mx.sentMessages().at(-1)?.body;
    expect(notice).toEqual({
      msgtype: 'm.notice',
      body: 'Recorded: Reject',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$sent1' } },
    });
    await bot.handleEvent(ROOM, reaction('$sent1', '1️⃣'));
    expect(core.ofType('chat.reply')).toHaveLength(1);
  });

  it('accepts a reply naming the option by text, number or keycap', async () => {
    const { bot, core } = await setup();
    for (const answer of ['approve', '2', '1️⃣']) {
      const { message_id } = await bot.ask({ text: 'Q', correlation_id: `cor_${answer}` });
      await bot.handleEvent(
        ROOM,
        msg(`> <@bot:example.org> Q\n\n${answer}`, {
          'm.relates_to': { 'm.in_reply_to': { event_id: message_id } },
        }),
      );
    }
    expect(core.ofType('chat.reply').map((e) => (e.payload as { choice: string }).choice)).toEqual([
      'Approve',
      'Reject',
      'Approve',
    ]);
    expect(core.ofType('chat.message')).toHaveLength(0);
  });

  it('treats a thread reply to the question like a reply', async () => {
    const { bot, core } = await setup();
    await bot.ask({ text: 'Q', correlation_id: 'cor_t' });
    await bot.handleEvent(
      ROOM,
      msg('Reject', { 'm.relates_to': { rel_type: 'm.thread', event_id: '$sent1' } }),
    );
    expect(core.ofType('chat.reply')[0]?.payload).toMatchObject({ choice: 'Reject' });
  });
});

describe('messages', () => {
  it('emits chat.message for text in an allowed room', async () => {
    const { bot, core } = await setup();
    const event = msg('/status', { 'm.relates_to': { 'm.in_reply_to': { event_id: '$old' } } });
    await bot.handleEvent(ROOM, event);
    expect(core.ofType('chat.message')).toEqual([
      {
        type: 'chat.message',
        dedup_key: `chat:message:${ROOM}:${event.event_id}`,
        payload: {
          text: '/status',
          from: { id: '@miro:example.org', name: 'Miro P', username: '@miro:example.org' },
          message_id: event.event_id,
          chat_id: ROOM,
          date: new Date(1_790_000_000_000).toISOString(),
          reply_to: '$old',
        },
      },
    ]);
  });

  it('ignores edits, notices, its own messages, other rooms, and warns once about encryption', async () => {
    const { bot, core, logs } = await setup();
    await bot.handleEvent(
      ROOM,
      msg('* fixed', { 'm.relates_to': { rel_type: 'm.replace', event_id: '$x' } }),
    );
    await bot.handleEvent(ROOM, msg('beep', { msgtype: 'm.notice' }));
    await bot.handleEvent(ROOM, msg('mine', {}, ME));
    await bot.handleEvent('!stranger:x', msg('hi'));
    const encrypted: MxEvent = { ...msg('x'), type: 'm.room.encrypted', content: {} };
    await bot.handleEvent(ROOM, encrypted);
    await bot.handleEvent(ROOM, { ...encrypted, event_id: '$e2' });
    expect(core.events).toHaveLength(0);
    expect(logs.filter((l) => l.includes('is encrypted'))).toHaveLength(1);
  });

  it('falls back to the localpart when the profile is unavailable', async () => {
    const { bot, core } = await setup();
    await bot.handleEvent(ROOM, msg('hi', {}, '@ghost:example.org'));
    expect((core.events[0]?.payload as { from: unknown }).from).toEqual({
      id: '@ghost:example.org',
      name: 'ghost',
      username: '@ghost:example.org',
    });
  });
});

describe('sync loop', () => {
  it('skips the history on first start, then persists since after each batch', async () => {
    const { bot, mx, core } = await setup();
    mx.syncs.push({
      next_batch: 's0',
      rooms: { join: { [ROOM]: { timeline: { events: [msg('old')] } } } },
    });
    mx.syncs.push(batch('s1', [msg('new')]));
    expect(await bot.pollOnce()).toBe(1);
    const [skip, first] = mx.of('GET', '/sync');
    expect(skip?.query).toMatchObject({ timeout: '0' });
    expect(skip?.query.since).toBeUndefined();
    expect(first?.query.since).toBe('s0');
    expect(JSON.parse(first?.query.filter ?? '{}')).toMatchObject({
      room: {
        rooms: [ROOM, OTHER],
        timeline: { types: ['m.room.message', 'm.reaction', 'm.room.encrypted'] },
      },
    });
    expect(core.state.get(STATE_SINCE)).toBe('s1');
    expect(core.ofType('chat.message').map((e) => (e.payload as { text: string }).text)).toEqual([
      'new',
    ]);
  });

  it('delivers the history with initial: all', async () => {
    const { bot, mx, core } = await setup({ initial: 'all' });
    mx.syncs.push(batch('s1', [msg('old')]));
    await bot.pollOnce();
    expect(mx.of('GET', '/sync')[0]?.query.since).toBeUndefined();
    expect(core.ofType('chat.message')).toHaveLength(1);
  });

  it('retries a failing batch without handling an event twice, then gives up on it', async () => {
    const { bot, mx, core, logs } = await setup();
    core.state.set(STATE_SINCE, 's0');
    const good = msg('good');
    const bad = msg('bad');
    const failing = core.emitEvent.bind(core);
    core.emitEvent = (input) =>
      (input.payload as { text?: string }).text === 'bad'
        ? Promise.reject(new Error('core down'))
        : failing(input);
    for (let i = 0; i < 3; i++) {
      mx.syncs.push(batch('s1', [good, bad]));
    }
    await expect(bot.pollOnce()).rejects.toThrow(/attempt 1/);
    await expect(bot.pollOnce()).rejects.toThrow(/attempt 2/);
    expect(core.state.get(STATE_SINCE)).toBe('s0');
    await bot.pollOnce();
    expect(core.state.get(STATE_SINCE)).toBe('s1');
    expect(core.ofType('chat.message')).toHaveLength(1);
    expect(logs.some((l) => l.includes(`giving up on event ${bad.event_id}`))).toBe(true);
  });

  it('waits for the rate limit before syncing again', async () => {
    const { bot, mx, sleeps, logs } = await setup();
    mx.syncs.push({ next_batch: 's0' });
    mx.syncs.push({
      status: 429,
      body: { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many', retry_after_ms: 2500 },
    });
    mx.syncs.push({ status: 502, body: {} });
    mx.syncs.push({ next_batch: 's1' });
    mx.onSync = (n) => {
      if (n >= 4) {
        bot.stop();
      }
    };
    await bot.start();
    expect(sleeps.slice(0, 2)).toEqual([2500, 2000]);
    expect(logs.some((l) => l.includes('Too many (429)'))).toBe(true);
  });
});

describe('helpers', () => {
  it('strips the reply fallback', () => {
    expect(stripReplyFallback('> <@a:b> question\n> more\n\nApprove')).toBe('Approve');
    expect(stripReplyFallback('> not a fallback')).toBe('> not a fallback');
  });

  it('matches answers by text, number and keycap', () => {
    const options = ['Deploy now', 'Tomorrow', 'Cancel'];
    expect(matchAnswer(' deploy NOW ', options)).toBe('Deploy now');
    expect(matchAnswer('3', options)).toBe('Cancel');
    expect(matchAnswer('4', options)).toBeUndefined();
    expect(matchAnswer(OPTION_KEYS[1] ?? '', options)).toBe('Tomorrow');
    expect(matchAnswer('maybe', options)).toBeUndefined();
  });
});
