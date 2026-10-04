// The chat connector's Matrix backend against the Synapse of compose.yaml, for
// `npm run smoke:connectors` (test/smoke/connectors/README.md). Before the daemon starts,
// `prepare` registers the `bot` and `human` users and lets the human make two rooms and
// invite the bot; the bot's access token becomes the connector's `token`. Then this module
// is the human: it reads what `send` and `ask` put in the rooms, posts messages, reactions
// and replies, and checks the `chat.message` and `chat.reply` events they become, across a
// connector restart. Telegram has no server one can run, so that backend stays on its unit
// tests. Everything the bot says is read back over the Client-Server API as the human.
/* global fetch, AbortSignal */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';

const HOMESERVER = 'http://127.0.0.1:38008';
const SERVER = 'smoke.local';
const PASSWORD = 'smoke-matrix-pass';
const BOT_ID = `@bot:${SERVER}`;
const HUMAN_ID = `@human:${SERVER}`;
const MAIN_ALIAS = `#smoke:${SERVER}`;
const SIDE_ALIAS = `#smoke-side:${SERVER}`;
const HISTORY = 'posted before the connector started: initial none must skip me';

/** Synapse answers /health once it serves. */
export const ports = [`${HOMESERVER}/health`];

let human;
let rooms = {};
/** How many chat.message events the human's posts should have produced so far. */
let expectedMessages = 0;

// --- the Client-Server API as the human ------------------------------------------------

class MatrixError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path}: ${body.errcode ?? status} ${body.error ?? ''}`.trim());
    this.errcode = body.errcode;
  }
}

async function mx(method, path, { token, body, query } = {}) {
  const url = new URL(`${HOMESERVER}/_matrix/client/v3${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const json = text === '' ? null : JSON.parse(text);
  if (!res.ok) {
    throw new MatrixError(method, path, res.status, json ?? {});
  }
  return json;
}

const seg = encodeURIComponent;

/** Registers `user` (or logs in when a kept server already has them); sets the display name. */
async function account(user, displayname) {
  let session;
  try {
    session = await mx('POST', '/register', {
      body: {
        username: user,
        password: PASSWORD,
        auth: { type: 'm.login.dummy' },
        initial_device_display_name: 'smoke',
      },
    });
  } catch (err) {
    if (err.errcode !== 'M_USER_IN_USE') {
      throw err;
    }
    session = await mx('POST', '/login', {
      body: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: PASSWORD,
        initial_device_display_name: 'smoke',
      },
    });
  }
  const me = { userId: session.user_id, token: session.access_token };
  await mx('PUT', `/profile/${seg(me.userId)}/displayname`, {
    token: me.token,
    body: { displayname },
  });
  return me;
}

/** The human makes a room under `alias` with `invite`d, or finds it when it already exists. */
async function room(alias, name, invite) {
  try {
    const made = await mx('POST', '/createRoom', {
      token: human.token,
      body: { preset: 'private_chat', name, room_alias_name: alias, invite },
    });
    return made.room_id;
  } catch (err) {
    if (err.errcode !== 'M_ROOM_IN_USE') {
      throw err;
    }
    const { room_id } = await mx('GET', `/directory/room/${seg(`#${alias}:${SERVER}`)}`);
    for (const user_id of invite) {
      try {
        await mx('POST', `/rooms/${seg(room_id)}/invite`, {
          token: human.token,
          body: { user_id },
        });
      } catch (e) {
        if (e.errcode !== 'M_FORBIDDEN') {
          throw e; // already joined is M_FORBIDDEN ("already in the room")
        }
      }
    }
    return room_id;
  }
}

const txn = () => `smoke${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

/** The human posts `content` of `type` to `roomId`; returns the event id. */
async function post(roomId, content, type = 'm.room.message') {
  const r = await mx('PUT', `/rooms/${seg(roomId)}/send/${seg(type)}/${txn()}`, {
    token: human.token,
    body: content,
  });
  return r.event_id;
}

const text = (body) => ({ msgtype: 'm.text', body });
const replyTo = (eventId) => ({ 'm.relates_to': { 'm.in_reply_to': { event_id: eventId } } });

/** One event as the human sees it. */
const event = (roomId, eventId) =>
  mx('GET', `/rooms/${seg(roomId)}/event/${seg(eventId)}`, { token: human.token });

/** The newest `limit` events of a room, newest first. */
async function messages(roomId, limit = 40) {
  const page = await mx('GET', `/rooms/${seg(roomId)}/messages`, {
    token: human.token,
    query: { dir: 'b', limit },
  });
  return page.chunk ?? [];
}

/** The room's events matching `pred`, waiting up to `ms` for at least `n`. */
async function roomEventsUntil(roomId, pred, n = 1, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = (await messages(roomId)).filter(pred);
    if (found.length >= n || Date.now() > deadline) {
      return found;
    }
    await sleep(200);
  }
}

/** The daemon's events of `type` matching `pred`, waiting up to `ms` for at least `n`. */
async function eventsUntil(rig, type, pred, n = 1, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = rig.events(type).filter(pred);
    if (found.length >= n || Date.now() > deadline) {
      return found;
    }
    await sleep(200);
  }
}

const byMessageId = (id) => (e) => e.payload.message_id === id;

// --- the rig -----------------------------------------------------------------------------

export function setup(rig) {
  rig.connector({
    name: 'chat_matrix',
    exec: ['247-agent-connector-chat'],
    emits: ['chat.message', 'chat.reply'],
    ops: ['send', 'ask'],
    config: {
      backend: 'matrix',
      homeserver: HOMESERVER,
      token: '${secrets.smoke_matrix_token}',
      chat_id: MAIN_ALIAS,
      allowed_chat_ids: [SIDE_ALIAS],
      poll_timeout: 5,
      initial: 'none',
    },
  });
  rig.op('chat_send', 'chat_matrix', 'send', ['text']);
  rig.op('chat_send_html', 'chat_matrix', 'send', ['text', 'parse_mode']);
  rig.op('chat_send_reply', 'chat_matrix', 'send', ['text', 'reply_to']);
  rig.op('chat_send_to', 'chat_matrix', 'send', ['text', 'chat_id']);
  rig.op('chat_ask', 'chat_matrix', 'ask', ['text', 'correlation_id', 'options']);
  rig.op('chat_ask_default', 'chat_matrix', 'ask', ['text', 'correlation_id']);
}

/** Users, rooms and the bot's token: what the connector needs to join at start. */
export async function prepare(rig) {
  const bot = await account('bot', 'Smoke Bot');
  human = await account('human', 'Smoke Human');
  rooms = {
    main: await room('smoke', 'Smoke', [bot.userId]),
    side: await room('smoke-side', 'Smoke side room', [bot.userId]),
  };
  // Room history the connector must not deliver (`initial: none`).
  await post(rooms.main, text(HISTORY));
  rig.secret('smoke_matrix_token', bot.token);
}

async function sends(rig) {
  rig.section('chat_matrix: send (plain, HTML, reply, another room, refusals)');
  const call = (op, payload) => rig.call(`chat_${op}`, payload);
  const hello = rig.succeeded('send', call('send', { text: 'hello from the daemon' }));
  rig.check(
    'returns the event id and the room id (not the alias)',
    typeof hello.message_id === 'string' &&
      hello.message_id.startsWith('$') &&
      hello.chat_id === rooms.main,
    JSON.stringify(hello),
  );
  const ev = hello.message_id === undefined ? {} : await event(rooms.main, hello.message_id);
  rig.check(
    'the bot posted it as m.text',
    ev.sender === BOT_ID &&
      ev.type === 'm.room.message' &&
      ev.content?.msgtype === 'm.text' &&
      ev.content.body === 'hello from the daemon',
    JSON.stringify([ev.sender, ev.content]),
  );

  const html = rig.succeeded(
    'send with parse_mode HTML',
    call('send_html', { text: '<b>bold</b> and <i>italic</i>', parse_mode: 'HTML' }),
  );
  const h = html.message_id === undefined ? {} : await event(rooms.main, html.message_id);
  rig.check(
    'formatted_body carries the HTML, body the text',
    h.content?.format === 'org.matrix.custom.html' &&
      h.content.formatted_body === '<b>bold</b> and <i>italic</i>' &&
      h.content.body === 'bold and italic',
    JSON.stringify(h.content),
  );

  const reply = rig.succeeded(
    'send with reply_to',
    call('send_reply', { text: 'a reply', reply_to: hello.message_id }),
  );
  const r = reply.message_id === undefined ? {} : await event(rooms.main, reply.message_id);
  rig.check(
    'm.in_reply_to points at the first message',
    r.content?.['m.relates_to']?.['m.in_reply_to']?.event_id === hello.message_id,
    JSON.stringify(r.content?.['m.relates_to']),
  );

  const side = rig.succeeded(
    'send to the side room by alias',
    call('send_to', { text: 'to the side room', chat_id: SIDE_ALIAS }),
  );
  rig.check('chat_id is the side room id', side.chat_id === rooms.side, JSON.stringify(side));
  const s = side.message_id === undefined ? {} : await event(rooms.side, side.message_id);
  rig.check('it landed there', s.content?.body === 'to the side room', JSON.stringify(s.content));
  const sideById = rig.succeeded(
    'send to the side room by id',
    call('send_to', { text: 'by id', chat_id: rooms.side }),
  );
  rig.check('same room', sideById.chat_id === rooms.side, JSON.stringify(sideById));

  rig.failed(
    'send to a room not in allowed_chat_ids',
    call('send_to', { text: 'x', chat_id: `!nope:${SERVER}` }),
    /not the configured chat_id/,
  );
  rig.failed(
    'reply_to with a Telegram-style number',
    call('send_reply', { text: 'x', reply_to: 123 }),
    /Matrix event id/,
  );
  rig.failed(
    'ask with 11 options',
    call('ask', {
      text: 'x',
      correlation_id: 'cor_too_many',
      options: Array.from({ length: 11 }, (_, i) => `o${i}`),
    }),
    /at most 10/,
  );
  return hello.message_id;
}

async function incoming(rig, firstBotMessage) {
  rig.section(
    'chat_matrix: chat.message (text, reply fallback, the side room, ignored kinds, initial: none)',
  );
  const plainId = await post(rooms.main, text('please update the opening hours'));
  expectedMessages++;
  const [plain] = await eventsUntil(rig, 'chat.message', byMessageId(plainId));
  rig.check(
    'a message becomes chat.message',
    plain !== undefined,
    plain === undefined ? 'no event' : plain.id,
  );
  const p = plain?.payload ?? {};
  rig.check(
    'text, from (user id and display name), chat_id, reply_to',
    p.text === 'please update the opening hours' &&
      p.from?.id === HUMAN_ID &&
      p.from.name === 'Smoke Human' &&
      p.from.username === HUMAN_ID &&
      p.chat_id === rooms.main &&
      p.reply_to === null &&
      typeof p.date === 'string',
    JSON.stringify(p),
  );
  rig.check(
    'source and dedup_key',
    plain?.source === 'chat_matrix' && plain.dedup_key === `chat:message:${rooms.main}:${plainId}`,
    JSON.stringify([plain?.source, plain?.dedup_key]),
  );
  const skipped = rig.events('chat.message').every((e) => e.payload.text !== HISTORY);
  rig.check(
    'the room history before the start was skipped',
    skipped,
    skipped ? '' : 'it was delivered',
  );

  const replyId = await post(rooms.main, {
    ...text(`> <${BOT_ID}> hello from the daemon\n\nreplying to the bot`),
    ...replyTo(firstBotMessage),
  });
  expectedMessages++;
  const [reply] = await eventsUntil(rig, 'chat.message', byMessageId(replyId));
  rig.check(
    'a reply: fallback quote stripped, reply_to set',
    reply?.payload.text === 'replying to the bot' && reply.payload.reply_to === firstBotMessage,
    JSON.stringify([reply?.payload.text, reply?.payload.reply_to]),
  );

  const sideId = await post(rooms.side, text('from the side room'));
  expectedMessages++;
  const [side] = await eventsUntil(rig, 'chat.message', byMessageId(sideId));
  rig.check(
    'a message in an allowed room carries that room id',
    side?.payload.chat_id === rooms.side,
    JSON.stringify(side?.payload.chat_id),
  );

  const noticeId = await post(rooms.main, {
    msgtype: 'm.notice',
    body: 'a notice from another bot',
  });
  const editId = await post(rooms.main, {
    ...text('* edited'),
    'm.new_content': text('edited'),
    'm.relates_to': { rel_type: 'm.replace', event_id: plainId },
  });
  const markerId = await post(rooms.main, text('marker after the ignored ones'));
  expectedMessages++;
  await eventsUntil(rig, 'chat.message', byMessageId(markerId));
  const ignored = rig
    .events('chat.message')
    .filter((e) => [noticeId, editId].includes(e.payload.message_id));
  rig.check(
    'a notice and an edit are ignored',
    ignored.length === 0,
    JSON.stringify(ignored.map((e) => e.payload)),
  );
}

async function questions(rig) {
  rig.section(
    'chat_matrix: ask (keycap reactions, a tap, a text reply, a thread reply, answered once)',
  );
  const q1 = rig.succeeded(
    'ask with options',
    rig.call('chat_ask', {
      text: 'Deploy the site?',
      correlation_id: 'cor_smoke_1',
      options: ['Deploy now', 'Tomorrow', 'Cancel'],
    }),
  );
  rig.check(
    'returns the options and the room',
    JSON.stringify(q1.options) === '["Deploy now","Tomorrow","Cancel"]' &&
      q1.chat_id === rooms.main,
    JSON.stringify(q1),
  );
  const qe = q1.message_id === undefined ? {} : await event(rooms.main, q1.message_id);
  rig.check(
    'the question lists the options with keycaps',
    typeof qe.content?.body === 'string' &&
      qe.content.body.startsWith('Deploy the site?') &&
      qe.content.body.includes('1️⃣ Deploy now') &&
      qe.content.body.includes('3️⃣ Cancel'),
    JSON.stringify(qe.content?.body),
  );
  const reactions = await roomEventsUntil(
    rooms.main,
    (e) =>
      e.type === 'm.reaction' &&
      e.sender === BOT_ID &&
      e.content?.['m.relates_to']?.event_id === q1.message_id,
    3,
  );
  rig.check(
    'the bot reacted with 1️⃣ 2️⃣ 3️⃣',
    JSON.stringify(reactions.map((e) => e.content['m.relates_to'].key).sort()) ===
      JSON.stringify(['1️⃣', '2️⃣', '3️⃣']),
    JSON.stringify(reactions.map((e) => e.content['m.relates_to'].key)),
  );

  await post(
    rooms.main,
    { 'm.relates_to': { rel_type: 'm.annotation', event_id: q1.message_id, key: '2️⃣' } },
    'm.reaction',
  );
  const [tap] = await eventsUntil(rig, 'chat.reply', byMessageId(q1.message_id));
  rig.check(
    'a tap on 2️⃣ becomes chat.reply',
    tap !== undefined,
    tap === undefined ? 'no event' : tap.id,
  );
  const t = tap?.payload ?? {};
  rig.check(
    'choice Tomorrow, approved false, correlation_id, no answer_message_id',
    t.choice === 'Tomorrow' &&
      t.approved === false &&
      t.text === 'Tomorrow' &&
      t.correlation_id === 'cor_smoke_1' &&
      t.answer_message_id === null &&
      t.chat_id === rooms.main &&
      t.from?.id === HUMAN_ID,
    JSON.stringify(t),
  );
  rig.check(
    'the event itself carries the correlation_id',
    tap?.correlation_id === 'cor_smoke_1' &&
      tap.dedup_key === `chat:reply:${rooms.main}:${q1.message_id}`,
    JSON.stringify([tap?.correlation_id, tap?.dedup_key]),
  );
  const [recorded] = await roomEventsUntil(
    rooms.main,
    (e) =>
      e.sender === BOT_ID &&
      e.content?.msgtype === 'm.notice' &&
      e.content['m.relates_to']?.['m.in_reply_to']?.event_id === q1.message_id,
  );
  rig.check(
    'the bot confirmed with "Recorded: Tomorrow"',
    recorded?.content.body === 'Recorded: Tomorrow',
    JSON.stringify(recorded?.content),
  );
  // A second tap on an answered question must do nothing; checked after the next answer lands.
  await post(
    rooms.main,
    { 'm.relates_to': { rel_type: 'm.annotation', event_id: q1.message_id, key: '1️⃣' } },
    'm.reaction',
  );

  const q2 = rig.succeeded(
    'ask with the default options',
    rig.call('chat_ask_default', { text: 'Approve the change?', correlation_id: 'cor_smoke_2' }),
  );
  rig.check(
    'Approve, Reject',
    JSON.stringify(q2.options) === '["Approve","Reject"]',
    JSON.stringify(q2.options),
  );
  const answerId = await post(rooms.main, { ...text('approve'), ...replyTo(q2.message_id) });
  const [typed] = await eventsUntil(rig, 'chat.reply', byMessageId(q2.message_id));
  rig.check(
    'a text reply naming an option answers: approved, text as typed, answer_message_id',
    typed?.payload.approved === true &&
      typed.payload.choice === 'Approve' &&
      typed.payload.text === 'approve' &&
      typed.payload.answer_message_id === answerId &&
      typed.correlation_id === 'cor_smoke_2',
    JSON.stringify(typed?.payload),
  );

  const q3 = rig.succeeded(
    'ask once more',
    rig.call('chat_ask_default', { text: 'Publish?', correlation_id: 'cor_smoke_3' }),
  );
  await post(rooms.main, {
    ...text('2'),
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: q3.message_id,
      is_falling_back: true,
      'm.in_reply_to': { event_id: q3.message_id },
    },
  });
  const [threaded] = await eventsUntil(rig, 'chat.reply', byMessageId(q3.message_id));
  rig.check(
    '"2" in the question\'s thread picks the second option',
    threaded?.payload.choice === 'Reject' && threaded.payload.approved === false,
    JSON.stringify(threaded?.payload),
  );

  const lateId = await post(rooms.main, { ...text('Cancel'), ...replyTo(q1.message_id) });
  expectedMessages++;
  const [late] = await eventsUntil(rig, 'chat.message', byMessageId(lateId));
  rig.check(
    'a reply to an answered question is an ordinary chat.message with reply_to',
    late?.payload.text === 'Cancel' && late.payload.reply_to === q1.message_id,
    JSON.stringify(late?.payload),
  );
  rig.check(
    'the first question was answered exactly once',
    rig.events('chat.reply').filter(byMessageId(q1.message_id)).length === 1,
    String(rig.events('chat.reply').filter(byMessageId(q1.message_id)).length),
  );
  rig.check(
    'three chat.reply events in all',
    rig.events('chat.reply').length === 3,
    String(rig.events('chat.reply').length),
  );
}

async function restart(rig) {
  rig.section('chat_matrix: restart (the since cursor and the open questions live in the core)');
  const q4 = rig.succeeded(
    'ask before the restart',
    rig.call('chat_ask_default', {
      text: 'Still there after a restart?',
      correlation_id: 'cor_smoke_4',
    }),
  );
  const status = rig.restart('chat_matrix');
  rig.check(
    'oa connector restart brings it back up',
    status.state === 'up' && status.error === null,
    JSON.stringify(status),
  );
  const afterId = await post(rooms.main, text('after the restart'));
  expectedMessages++;
  const [after] = await eventsUntil(rig, 'chat.message', byMessageId(afterId), 1, 20_000);
  rig.check(
    'a message after the restart arrives',
    after?.payload.text === 'after the restart',
    JSON.stringify(after?.payload.text),
  );
  rig.check(
    `no message was replayed (${String(expectedMessages)} chat.message events in all)`,
    rig.events('chat.message').length === expectedMessages,
    String(rig.events('chat.message').length),
  );
  await post(
    rooms.main,
    { 'm.relates_to': { rel_type: 'm.annotation', event_id: q4.message_id, key: '1️⃣' } },
    'm.reaction',
  );
  const [answered] = await eventsUntil(rig, 'chat.reply', byMessageId(q4.message_id));
  rig.check(
    'the question asked before the restart is still answerable',
    answered?.payload.approved === true && answered.correlation_id === 'cor_smoke_4',
    JSON.stringify(answered?.payload),
  );
}

export async function run(rig) {
  const first = await sends(rig);
  await incoming(rig, first);
  await questions(rig);
  await restart(rig);
}
