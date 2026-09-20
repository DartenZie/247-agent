import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { Pop3Client, Pop3Mailbox, unstuff } from './pop3.js';
import { incomingConfig, MemoryState } from './test-helpers.js';

interface StoredMail {
  uidl: string;
  source: string;
}

/** A scripted POP3 server: USER/PASS, STAT, UIDL, RETR, DELE, QUIT; deletes commit at QUIT. */
class FakePop3Server {
  readonly mails: StoredMail[] = [];
  readonly log: string[] = [];
  private server: Server | null = null;
  port = 0;

  constructor(private readonly creds: { user: string; pass: string } = { user: 'u', pass: 'p' }) {}

  add(uidl: string, source: string): void {
    this.mails.push({ uidl, source });
  }

  async start(): Promise<void> {
    const server = createServer((socket) => {
      this.session(socket);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    await new Promise<void>((resolve) => {
      if (server === null) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
  }

  private session(socket: Socket): void {
    const snapshot = [...this.mails];
    const deleted = new Set<number>();
    let user: string | null = null;
    let authed = false;
    let buf = '';
    socket.write('+OK fake POP3 ready\r\n');
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let eol: number;
      while ((eol = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        this.log.push(line.startsWith('PASS') ? 'PASS ****' : line);
        const [cmd, arg] = line.split(' ');
        const n = Number(arg);
        const live = (i: number): boolean => i >= 1 && i <= snapshot.length && !deleted.has(i);
        switch (cmd) {
          case 'USER':
            user = arg ?? null;
            socket.write('+OK\r\n');
            break;
          case 'PASS':
            authed = user === this.creds.user && arg === this.creds.pass;
            socket.write(authed ? '+OK logged in\r\n' : '-ERR bad password\r\n');
            break;
          case 'STAT':
            socket.write(`+OK ${String(snapshot.length - deleted.size)} 0\r\n`);
            break;
          case 'UIDL': {
            const lines = snapshot.flatMap((m, i) =>
              live(i + 1) ? [`${String(i + 1)} ${m.uidl}`] : [],
            );
            socket.write(['+OK', ...lines, '.'].join('\r\n') + '\r\n');
            break;
          }
          case 'RETR': {
            const m = snapshot[n - 1];
            if (!live(n) || m === undefined) {
              socket.write('-ERR no such message\r\n');
              break;
            }
            const stuffed = m.source.replace(/(^|\r\n)\./g, '$1..');
            socket.write(`+OK message follows\r\n${stuffed}\r\n.\r\n`);
            break;
          }
          case 'DELE':
            if (live(n)) {
              deleted.add(n);
              socket.write('+OK\r\n');
            } else {
              socket.write('-ERR no such message\r\n');
            }
            break;
          case 'QUIT':
            for (const i of [...deleted].sort((a, b) => b - a)) {
              const m = snapshot[i - 1];
              const idx = m === undefined ? -1 : this.mails.indexOf(m);
              if (idx >= 0) {
                this.mails.splice(idx, 1);
              }
            }
            socket.end('+OK bye\r\n');
            break;
          default:
            socket.write('-ERR unknown command\r\n');
        }
      }
    });
  }
}

const mail = (id: string, body: string): string =>
  `From: a@example.cz\r\nSubject: ${id}\r\nMessage-ID: <${id}@x>\r\n\r\n${body}`;

let server: FakePop3Server;
afterEach(async () => {
  await server.stop();
});

function mailbox(extra: Record<string, unknown> = {}) {
  const config = incomingConfig({
    protocol: 'pop3',
    host: '127.0.0.1',
    port: server.port,
    secure: false,
    starttls: false,
    user: 'u',
    password: 'p',
    ...extra,
  });
  const state = new MemoryState();
  const log: string[] = [];
  return { state, log, mailbox: new Pop3Mailbox(config, state, (l) => log.push(l)) };
}

describe('Pop3Client', () => {
  it('speaks the protocol and unstuffs dotted lines', async () => {
    server = new FakePop3Server();
    server.add('u1', mail('m1', 'line one\r\n.dot line\r\n..two dots'));
    await server.start();
    const c = await Pop3Client.connect({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      starttls: false,
      rejectUnauthorized: true,
    });
    await c.login('u', 'p');
    expect(await c.stat()).toEqual({ count: 1, size: 0 });
    expect(await c.uidl()).toEqual([{ num: 1, uidl: 'u1' }]);
    const src = await c.retr(1);
    expect(src.toString('utf8')).toBe(mail('m1', 'line one\r\n.dot line\r\n..two dots'));
    await c.quit();
    expect(server.log).toEqual(['USER u', 'PASS ****', 'STAT', 'UIDL', 'RETR 1', 'QUIT']);
  });

  it('turns -ERR into an exception without leaking the password', async () => {
    server = new FakePop3Server();
    await server.start();
    const c = await Pop3Client.connect({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      starttls: false,
      rejectUnauthorized: true,
    });
    await expect(c.login('u', 'wrong')).rejects.toThrow(/PASS \*\*\*\* failed: -ERR bad password/);
    c.close();
  });
});

describe('unstuff', () => {
  it('removes one leading dot from dot-stuffed lines only', () => {
    expect(unstuff(Buffer.from('a\r\n..b\r\n...c\r\n.d')).toString()).toBe('a\r\n.b\r\n..c\r\n.d');
    expect(unstuff(Buffer.alloc(0)).length).toBe(0);
  });
});

describe('Pop3Mailbox', () => {
  it('skips existing mail on first run, then delivers only unseen UIDLs', async () => {
    server = new FakePop3Server();
    server.add('old', mail('old', 'x'));
    await server.start();
    const { mailbox: mb, state, log } = mailbox();
    expect(await mb.fetchNew({})).toEqual({ emails: [], last_uid: null });
    expect(log[0]).toMatch(/skipping 1 existing/);
    expect(await state.getState('seen_uidls')).toEqual(['old']);

    server.add('new1', mail('n1', 'first'));
    server.add('new2', mail('n2', 'second'));
    const r = await mb.fetchNew({ since_uid: 'ignored' });
    expect(r.emails.map((e) => [e.uid, e.message_id, e.body])).toEqual([
      ['new1', '<n1@x>', 'first'],
      ['new2', '<n2@x>', 'second'],
    ]);
    expect(r.last_uid).toBe('new2');
    expect(await state.getState('seen_uidls')).toEqual(['old', 'new1', 'new2']);
    expect(server.mails).toHaveLength(3);

    expect(await mb.fetchNew({})).toEqual({ emails: [], last_uid: 'new2' });
  });

  it('delivers everything with initial: all, honours limit, forgets UIDLs gone from the server', async () => {
    server = new FakePop3Server();
    server.add('a', mail('a', '1'));
    server.add('b', mail('b', '2'));
    server.add('c', mail('c', '3'));
    await server.start();
    const { mailbox: mb, state } = mailbox({ initial: 'all', limit: 2 });
    expect((await mb.fetchNew({})).emails.map((e) => e.uid)).toEqual(['a', 'b']);
    server.mails.splice(0, 1); // 'a' removed by another client
    expect((await mb.fetchNew({})).emails.map((e) => e.uid)).toEqual(['c']);
    expect(await state.getState('seen_uidls')).toEqual(['b', 'c']);
  });

  it('deletes fetched mail on the server when configured', async () => {
    server = new FakePop3Server();
    server.add('a', mail('a', '1'));
    server.add('b', mail('b', '2'));
    await server.start();
    const { mailbox: mb, state } = mailbox({ initial: 'all', delete_after_fetch: true });
    expect((await mb.fetchNew({})).emails.map((e) => e.uid)).toEqual(['a', 'b']);
    expect(server.mails).toEqual([]);
    expect(server.log).toContain('DELE 1');
    expect(server.log).toContain('DELE 2');
    expect(await state.getState('seen_uidls')).toEqual([]);
    expect(await mb.fetchNew({})).toEqual({ emails: [], last_uid: 'b' });
  });

  it('fails the call when the login is refused and reports mark_read as unsupported', async () => {
    server = new FakePop3Server({ user: 'u', pass: 'other' });
    await server.start();
    const { mailbox: mb } = mailbox();
    await expect(mb.fetchNew({})).rejects.toThrow(/bad password/);
    expect(await mb.markRead({ uid: 'x' })).toEqual({ ok: false, supported: false });
  });
});
