// The email connector against the servers of compose.yaml, for `npm run smoke:connectors`
// (test/smoke/connectors/README.md). One connector per way in: IMAP and POP3 in plain
// text, with implicit TLS and with STARTTLS, each sending through the SMTP port of the same
// kind to its own mailbox and fetching the mail back; plus connectors that must refuse to
// talk: a plain port without STARTTLS while `starttls` is on, and a self-signed certificate
// while `reject_unauthorized` is on. GreenMail's users are these connectors' `user`s.
import { Buffer } from 'node:buffer';
import { setTimeout as sleep } from 'node:timers/promises';

import { ImapFlow } from 'imapflow';

const PASS = 'smoke-mail-pass';
const HOST = '127.0.0.1';
const FOOTER = '--\nSmoke footer';

/** Ports that greet in plain text once the servers are up (the TLS ones only after a handshake). */
export const ports = [3025, 3143, 3110, 31587, 31143, 31110];

const IMAP_PLAIN = { protocol: 'imap', port: 3143, secure: false, starttls: false };
const SMTP_PLAIN = { port: 3025, secure: false, starttls: false };
// GreenMail's TLS ports are not 993/995/465, from which the connector infers `secure`.
const SMTP_TLS = { port: 3465, secure: true, reject_unauthorized: false };
const SMTP_STARTTLS = { port: 31587, starttls: true, reject_unauthorized: false };

/** Every mailbox that sends to itself and fetches the mail back. */
const ROUND_TRIPS = [
  {
    name: 'mail_imap',
    label: 'IMAP plain 3143, SMTP plain 3025',
    incoming: IMAP_PLAIN,
    outgoing: SMTP_PLAIN,
  },
  {
    name: 'mail_imaps',
    label: 'IMAP TLS 3993, SMTP TLS 3465',
    incoming: { protocol: 'imap', port: 3993, secure: true, reject_unauthorized: false },
    outgoing: SMTP_TLS,
  },
  {
    name: 'mail_imap_starttls',
    label: 'IMAP STARTTLS 31143, SMTP STARTTLS 31587 (Dovecot)',
    incoming: { protocol: 'imap', port: 31143, starttls: true, reject_unauthorized: false },
    outgoing: SMTP_STARTTLS,
  },
  {
    name: 'mail_pop3',
    label: 'POP3 plain 3110, SMTP plain 3025',
    incoming: { protocol: 'pop3', port: 3110, secure: false, starttls: false },
    outgoing: SMTP_PLAIN,
  },
  {
    name: 'mail_pop3s',
    label: 'POP3 TLS 3995, SMTP TLS 3465',
    incoming: { protocol: 'pop3', port: 3995, secure: true, reject_unauthorized: false },
    outgoing: SMTP_TLS,
  },
  {
    name: 'mail_pop3_stls',
    label: 'POP3 STLS 31110, SMTP STARTTLS 31587 (Dovecot)',
    incoming: { protocol: 'pop3', port: 31110, starttls: true, reject_unauthorized: false },
    outgoing: SMTP_STARTTLS,
  },
];

const address = (user) => `${user}@example.com`;

function mailbox(rig, name, user, incoming, outgoing) {
  rig.connector({
    name,
    exec: ['247-agent-connector-email'],
    ops: ['fetch_new', 'mark_read', 'send'],
    config: {
      user,
      password: '${secrets.smoke_mail_pass}',
      incoming: { host: HOST, initial: 'none', ...incoming },
      outgoing: { host: HOST, from: `Smoke <${address(user)}>`, footer: FOOTER, ...outgoing },
    },
  });
  rig.op(`${name}_fetch`, name, 'fetch_new', ['limit']);
  rig.op(`${name}_send`, name, 'send', ['to', 'subject', 'text']);
  rig.op(`${name}_mark_read`, name, 'mark_read', ['uid']);
}

export function setup(rig) {
  rig.secret('smoke_mail_pass', PASS);
  for (const m of ROUND_TRIPS) {
    mailbox(rig, m.name, m.name, m.incoming, m.outgoing);
  }
  // The first round trip also covers the rest of `send` and `mark_read`.
  rig.op('mail_imap_send_full', 'mail_imap', 'send', [
    'to',
    'subject',
    'text',
    'html',
    'attachments',
  ]);
  rig.op('mail_imap_reply', 'mail_imap', 'send', [
    'to',
    'subject',
    'text',
    'in_reply_to',
    'references',
  ]);
  rig.op('mail_imap_mark_read_id', 'mail_imap', 'mark_read', ['message_id']);

  // `starttls` defaults to true: on a plain port of a server without STARTTLS the
  // connector must give up instead of logging in in clear text.
  mailbox(
    rig,
    'mail_cleartext',
    'mail_cleartext',
    { protocol: 'imap', port: 3143 },
    { port: 3025 },
  );
  mailbox(
    rig,
    'mail_pop3_cleartext',
    'mail_cleartext',
    { protocol: 'pop3', port: 3110 },
    { port: 3025 },
  );
  // `reject_unauthorized` defaults to true: GreenMail's self-signed certificate is refused.
  mailbox(
    rig,
    'mail_verify',
    'mail_verify',
    { protocol: 'imap', port: 3993, secure: true },
    { port: 3465, secure: true },
  );
}

/** Fetches until at least `n` messages came back (delivery is quick, not instant). */
async function fetchUntil(rig, name, n, limit = 50) {
  const emails = [];
  for (let i = 0; i < 20 && emails.length < n; i++) {
    const run = rig.call(`${name}_fetch`, { limit });
    if (run.status !== 'succeeded') {
      return { run, emails };
    }
    emails.push(...run.result.emails);
    if (emails.length < n) {
      await sleep(250);
    }
  }
  return { run: undefined, emails };
}

async function roundTrip(rig, { name, label, incoming }) {
  rig.section(`${name}: ${label}`);
  const to = address(name);
  const first = rig.succeeded('first fetch_new', rig.call(`${name}_fetch`, { limit: 50 }));
  rig.check(
    'initial: none returns nothing',
    first.emails?.length === 0,
    JSON.stringify(first.emails?.length),
  );
  const sent = rig.succeeded(
    'send',
    rig.call(`${name}_send`, { to, subject: `smoke ${name}`, text: `Hello from ${name}.` }),
  );
  rig.check('accepted', sent.accepted?.includes(to), JSON.stringify(sent.accepted));
  const { run, emails } = await fetchUntil(rig, name, 1);
  if (run !== undefined) {
    rig.succeeded('fetch_new', run);
  }
  const mail = emails[0];
  rig.check(
    'fetch_new returns the mail',
    emails.length === 1 && mail.subject === `smoke ${name}` && mail.from === to,
    JSON.stringify(emails.map((e) => [e.subject, e.from])),
  );
  rig.check(
    'footer appended',
    mail?.body.includes('Smoke footer') === true,
    JSON.stringify(mail?.body),
  );
  rig.check(
    'message_id round-trips',
    mail?.message_id === sent.message_id,
    `${mail?.message_id} / ${sent.message_id}`,
  );
  const again = rig.succeeded('fetch_new again', rig.call(`${name}_fetch`, { limit: 50 }));
  rig.check(
    'the cursor moved past it',
    again.emails?.length === 0,
    JSON.stringify(again.emails?.length),
  );
  if (incoming.protocol === 'pop3' && mail !== undefined) {
    const r = rig.succeeded('mark_read', rig.call(`${name}_mark_read`, { uid: mail.uid }));
    rig.check(
      'mark_read is unsupported on POP3',
      r.ok === false && r.supported === false,
      JSON.stringify(r),
    );
  }
  return mail;
}

/** The flags GreenMail holds for `uids` in mail_imap's INBOX, read over a separate session. */
async function flags(uids) {
  const client = new ImapFlow({
    host: HOST,
    port: 3143,
    secure: false,
    doSTARTTLS: false,
    auth: { user: 'mail_imap', pass: PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const out = {};
    for (const m of await client.fetchAll(uids, { uid: true, flags: true }, { uid: true })) {
      out[m.uid] = [...m.flags];
    }
    return out;
  } finally {
    lock.release();
    await client.logout();
  }
}

async function imapDetails(rig) {
  rig.section('mail_imap: send with html and attachment, reply threading, mark_read, limit');
  const to = address('mail_imap');
  const sent = rig.succeeded(
    'send with html and an attachment',
    rig.call('mail_imap_send_full', {
      to,
      subject: 'smoke full',
      text: 'Text part.',
      html: '<html><body><p>HTML part.</p></body></html>',
      attachments: [
        {
          filename: 'note.txt',
          content: Buffer.from('attached text\n').toString('base64'),
          encoding: 'base64',
          content_type: 'text/plain',
        },
      ],
    }),
  );
  const [full] = (await fetchUntil(rig, 'mail_imap', 1)).emails;
  rig.check(
    'text part as body, footer appended',
    /Text part\.[\s\S]*Smoke footer/.test(full?.body ?? ''),
    JSON.stringify(full?.body),
  );
  rig.check(
    'attachment metadata',
    full?.attachments?.length === 1 &&
      full.attachments[0].filename === 'note.txt' &&
      full.attachments[0].size > 0,
    JSON.stringify(full?.attachments),
  );

  const reply = rig.succeeded(
    'reply',
    rig.call('mail_imap_reply', {
      to,
      subject: 'Re: smoke full',
      text: 'A reply.',
      in_reply_to: sent.message_id,
      references: [sent.message_id],
    }),
  );
  const [threaded] = (await fetchUntil(rig, 'mail_imap', 1)).emails;
  rig.check(
    'in_reply_to and references',
    threaded?.in_reply_to === sent.message_id && threaded?.references.includes(sent.message_id),
    JSON.stringify([threaded?.in_reply_to, threaded?.references]),
  );

  if (full !== undefined && threaded !== undefined) {
    const byUid = rig.succeeded(
      'mark_read by uid',
      rig.call('mail_imap_mark_read', { uid: full.uid }),
    );
    rig.check(
      'mark_read reports ok',
      byUid.ok === true && byUid.supported === true,
      JSON.stringify(byUid),
    );
    let seen = await flags([full.uid, threaded.uid]);
    rig.check(
      '\\Seen set on that message only',
      seen[full.uid]?.includes('\\Seen') && !seen[threaded.uid]?.includes('\\Seen'),
      JSON.stringify(seen),
    );
    rig.succeeded(
      'mark_read by message_id',
      rig.call('mail_imap_mark_read_id', { message_id: reply.message_id }),
    );
    seen = await flags([threaded.uid]);
    rig.check(
      '\\Seen set by message_id',
      seen[threaded.uid]?.includes('\\Seen') === true,
      JSON.stringify(seen),
    );
  }

  for (const n of [1, 2, 3]) {
    rig.succeeded(
      `send batch ${n}`,
      rig.call('mail_imap_send', { to, subject: `batch ${n}`, text: `${n}` }),
    );
  }
  await sleep(500);
  const page = rig.succeeded('fetch_new with limit 2', rig.call('mail_imap_fetch', { limit: 2 }));
  rig.check(
    'the oldest two, in UID order',
    JSON.stringify(page.emails?.map((e) => e.subject)) === '["batch 1","batch 2"]',
    JSON.stringify(page.emails?.map((e) => e.subject)),
  );
  const rest = rig.succeeded('fetch_new for the rest', rig.call('mail_imap_fetch', { limit: 50 }));
  rig.check(
    'then the third',
    JSON.stringify(rest.emails?.map((e) => e.subject)) === '["batch 3"]',
    JSON.stringify(rest.emails?.map((e) => e.subject)),
  );
}

function refusals(rig) {
  rig.section('refusals: no STARTTLS on a plain port, an unverified certificate');
  const to = address('mail_cleartext');
  const send = { to, subject: 'must not be sent', text: 'x' };
  rig.failed('IMAP without STARTTLS', rig.call('mail_cleartext_fetch', { limit: 50 }), /STARTTLS/i);
  rig.failed('SMTP without STARTTLS', rig.call('mail_cleartext_send', send), /STARTTLS/i);
  rig.failed(
    'POP3 without STLS',
    rig.call('mail_pop3_cleartext_fetch', { limit: 50 }),
    /STLS|STARTTLS/i,
  );
  rig.failed(
    'IMAP TLS, self-signed certificate',
    rig.call('mail_verify_fetch', { limit: 50 }),
    /certificate/i,
  );
  rig.failed(
    'SMTP TLS, self-signed certificate',
    rig.call('mail_verify_send', { ...send, to: address('mail_verify') }),
    /certificate/i,
  );
}

export async function run(rig) {
  for (const m of ROUND_TRIPS) {
    await roundTrip(rig, m);
  }
  await imapDetails(rig);
  refusals(rig);
}
