import { createServer, type AddressInfo, type Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { imapFlowOptions, ImapMailbox, type ImapClient } from './imap.js';
import { incomingConfig, MemoryState } from './test-helpers.js';

const rfc822 = (id: string, subject: string): Buffer =>
  Buffer.from(
    `From: a@example.com\r\nSubject: ${subject}\r\nMessage-ID: <${id}@x>\r\n\r\n${subject} body\r\n`,
  );

interface FakeServer {
  uidValidity: bigint;
  messages: Map<number, { source: Buffer; flags: Set<string> }>;
  calls: string[];
}

function fakeClient(server: FakeServer): ImapClient {
  let open: string | null = null;
  const uids = (): number[] => [...server.messages.keys()].sort((a, b) => a - b);
  return {
    connect: () => {
      server.calls.push('connect');
      return Promise.resolve();
    },
    logout: () => {
      server.calls.push('logout');
      return Promise.resolve();
    },
    close: () => {
      server.calls.push('close');
    },
    getMailboxLock: (path) => {
      open = path;
      server.calls.push(`open ${path}`);
      return Promise.resolve({ release: () => server.calls.push('release') });
    },
    get mailbox() {
      if (open === null) {
        return false as const;
      }
      const max = uids().at(-1) ?? 0;
      return { uidValidity: server.uidValidity, uidNext: max + 1 };
    },
    search: (query) => {
      server.calls.push(`search ${JSON.stringify(query)}`);
      if (query.uid !== undefined) {
        const [lo] = query.uid.split(':');
        const from = Number(lo);
        const all = uids();
        const hit = all.filter((u) => u >= from);
        // IMAP quirk: `n:*` with n past the highest UID still matches the highest one.
        return Promise.resolve(hit.length === 0 ? all.slice(-1) : hit);
      }
      const wanted = query.header?.['message-id'];
      return Promise.resolve(
        uids().filter(
          (u) => server.messages.get(u)?.source.includes(`Message-ID: ${wanted ?? ''}`) ?? false,
        ),
      );
    },
    fetchAll: (range) => {
      server.calls.push(`fetch ${range.join(',')}`);
      return Promise.resolve(
        range.map((uid) => ({ uid, source: server.messages.get(uid)?.source })),
      );
    },
    messageFlagsAdd: (range, flags) => {
      for (const uid of range) {
        for (const f of flags) {
          server.messages.get(uid)?.flags.add(f);
        }
      }
      return Promise.resolve(true);
    },
  };
}

function setup(extra: Record<string, unknown> = {}, uidList: number[] = [1, 2, 3]) {
  const server: FakeServer = { uidValidity: 100n, messages: new Map(), calls: [] };
  for (const u of uidList) {
    server.messages.set(u, {
      source: rfc822(`m${String(u)}`, `Mail ${String(u)}`),
      flags: new Set(),
    });
  }
  const config = incomingConfig(extra);
  const state = new MemoryState();
  const log: string[] = [];
  const mailbox = new ImapMailbox(
    config,
    state,
    (l) => log.push(l),
    () => fakeClient(server),
  );
  return { server, state, log, mailbox };
}

describe('ImapMailbox.fetchNew', () => {
  it('returns UIDs above since_uid in order, with the cursor to pass back', async () => {
    const { mailbox, state, server } = setup();
    const r = await mailbox.fetchNew({ since_uid: 1 });
    expect(r.emails.map((e) => [e.uid, e.subject, e.message_id])).toEqual([
      [2, 'Mail 2', '<m2@x>'],
      [3, 'Mail 3', '<m3@x>'],
    ]);
    expect(r.last_uid).toBe(3);
    expect(await state.getState('uidvalidity')).toBe('100');
    expect(server.calls).toEqual([
      'connect',
      'open INBOX',
      'search {"uid":"2:*"}',
      'fetch 2,3',
      'release',
      'logout',
    ]);
    // Nothing new: the `n:*` quirk must not re-deliver the last message.
    const again = await mailbox.fetchNew({ since_uid: 3 });
    expect(again).toEqual({ emails: [], last_uid: 3 });
  });

  it('skips the existing mailbox on first run by default, or delivers it with initial: all', async () => {
    const none = setup();
    expect(await none.mailbox.fetchNew({ since_uid: null })).toEqual({ emails: [], last_uid: 3 });
    expect(none.log[0]).toMatch(/no cursor, skipping 3/);
    const all = setup({ initial: 'all' });
    const r = await all.mailbox.fetchNew({});
    expect(r.emails.map((e) => e.uid)).toEqual([1, 2, 3]);
  });

  it('keeps no cursor of its own, so mail from a failed run comes back', async () => {
    // The task commits `last_uid` only when its run succeeds; a run that failed passes the
    // old cursor again. The connector's namespace is the one the task writes `last_uid` to.
    const { mailbox, state } = setup();
    expect((await mailbox.fetchNew({ since_uid: 1 })).emails.map((e) => e.uid)).toEqual([2, 3]);
    expect(await state.getState('last_uid')).toBeUndefined();
    expect((await mailbox.fetchNew({ since_uid: 1 })).emails.map((e) => e.uid)).toEqual([2, 3]);
  });

  it('treats an absent since_uid as no cursor, whatever another caller stored', async () => {
    const { mailbox, state } = setup({ initial: 'all' });
    await state.putState('last_uid', 2);
    await state.putState('uidvalidity', '100');
    const r = await mailbox.fetchNew({});
    expect(r.emails.map((e) => e.uid)).toEqual([1, 2, 3]);
    expect(await state.getState('last_uid')).toBe(2);
  });

  it('resets the cursor when UIDVALIDITY changes', async () => {
    const { mailbox, state, server, log } = setup({ initial: 'all' });
    await state.putState('uidvalidity', '99');
    server.uidValidity = 100n;
    const r = await mailbox.fetchNew({ since_uid: 3 });
    expect(r.emails.map((e) => e.uid)).toEqual([1, 2, 3]);
    expect(log[0]).toMatch(/UIDVALIDITY changed 99 -> 100/);
    expect(await state.getState('uidvalidity')).toBe('100');
  });

  it('honours the limit and the folder argument', async () => {
    const { mailbox, server } = setup({ limit: 2, initial: 'all' }, [5, 6, 7, 8]);
    const first = await mailbox.fetchNew({ folder: 'Archive', limit: 10 });
    expect(first.emails.map((e) => e.uid)).toEqual([5, 6]);
    expect(first.last_uid).toBe(6);
    expect(server.calls).toContain('open Archive');
    const second = await mailbox.fetchNew({ since_uid: first.last_uid, limit: 1 });
    expect(second.emails.map((e) => e.uid)).toEqual([7]);
  });

  it('rejects a cursor that is not a whole number', async () => {
    const { mailbox } = setup();
    await expect(mailbox.fetchNew({ since_uid: 'abc' })).rejects.toThrow(/non-negative integer/);
  });
});

describe('ImapMailbox.markRead', () => {
  it('flags by uid or by message id and reports a miss', async () => {
    const { mailbox, server } = setup();
    expect(await mailbox.markRead({ uid: 2 })).toEqual({ ok: true, supported: true });
    expect(server.messages.get(2)?.flags.has('\\Seen')).toBe(true);
    expect(await mailbox.markRead({ message_id: '<m3@x>' })).toEqual({ ok: true, supported: true });
    expect(server.messages.get(3)?.flags.has('\\Seen')).toBe(true);
    expect(await mailbox.markRead({ message_id: '<nope@x>' })).toEqual({
      ok: false,
      supported: true,
    });
    await expect(mailbox.markRead({})).rejects.toThrow(/uid or message_id/);
  });
});

describe('imapFlowOptions', () => {
  it('requires STARTTLS on a plain port unless starttls is off', () => {
    expect(imapFlowOptions(incomingConfig({ port: 143 })).doSTARTTLS).toBe(true);
    expect(imapFlowOptions(incomingConfig({ port: 143, starttls: false })).doSTARTTLS).toBe(
      undefined,
    );
    const tls = imapFlowOptions(incomingConfig());
    expect([tls.secure, tls.port, tls.doSTARTTLS]).toEqual([true, 993, undefined]);
  });
});

/**
 * A plain-text IMAP server that never offers STARTTLS and records every command. It
 * advertises no AUTH mechanism, so a client that logs in sends LOGIN with the password in
 * clear. `closed` settles once every accepted connection has closed.
 */
async function withPlainImapServer(
  run: (port: number, commands: string[], closed: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const closing: Promise<void>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    closing.push(
      new Promise((resolve) =>
        socket.on('close', () => {
          resolve();
        }),
      ),
    );
    socket.write('* OK [CAPABILITY IMAP4rev1] ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        const [tag = '*', verb = ''] = line.split(' ');
        if (verb.toUpperCase() === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        } else if (verb.toUpperCase() === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK bye\r\n`);
        } else {
          socket.write(`${tag} NO not here\r\n`);
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port, commands, async () => {
      await Promise.all(closing);
    });
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}

describe('ImapMailbox over a plain port', () => {
  it('refuses to log in when the server offers no STARTTLS, and closes the connection', async () => {
    await withPlainImapServer(async (port, commands, closed) => {
      const config = incomingConfig({
        host: '127.0.0.1',
        port,
        secure: false,
        user: 'u',
        password: 'secret-password',
      });
      const mailbox = new ImapMailbox(config, new MemoryState(), () => undefined);
      await expect(mailbox.fetchNew({})).rejects.toThrow(/STARTTLS/);
      expect(commands.filter((c) => /^\S+ (LOGIN|AUTHENTICATE)\b/i.test(c))).toEqual([]);
      // A socket left open after a failed connect times out later with no 'error'
      // listener and takes the connector down.
      await closed();
    });
  });
});
