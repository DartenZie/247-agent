/**
 * A minimal POP3 client (RFC 1939, plus STLS from RFC 2595) and the mailbox on top of it.
 * The protocol is small enough that a dependency-free client is simpler to keep correct
 * than an unmaintained package: USER/PASS, STAT, UIDL, RETR, DELE, QUIT.
 *
 * POP3 has no stable numbering across sessions and no flags, so "new" is decided with the
 * set of UIDLs already delivered, kept in the connector's state (`seen_uidls`). Deletions
 * (`delete_after_fetch`) take effect at QUIT, as the RFC says.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import type { IncomingConfig } from './config.js';
import { parseMessage } from './parse.js';
import type {
  EmailMessage,
  FetchNewArgs,
  FetchNewResult,
  Log,
  Mailbox,
  MarkReadArgs,
  MarkReadResult,
  StateStore,
} from './types.js';

const CRLF = Buffer.from('\r\n');
const MULTILINE_END = Buffer.from('\r\n.\r\n');

/** How many delivered UIDLs to remember when the server keeps messages. */
const MAX_SEEN = 20_000;

export interface Pop3ConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  starttls: boolean;
  rejectUnauthorized: boolean;
  timeoutMs?: number;
}

interface Waiter {
  multiline: boolean;
  resolve: (r: { ok: boolean; line: string; data: Buffer }) => void;
  reject: (err: Error) => void;
}

export class Pop3Client {
  private socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private waiter: Waiter | null = null;
  private closed: Error | null = null;
  private readonly timeoutMs: number;

  private constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attach(socket);
  }

  /** Opens the connection, reads the greeting and upgrades with STLS when configured. */
  static async connect(opts: Pop3ConnectOptions): Promise<Pop3Client> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = opts.secure
        ? tlsConnect({
            host: opts.host,
            port: opts.port,
            servername: opts.host,
            rejectUnauthorized: opts.rejectUnauthorized,
          })
        : netConnect({ host: opts.host, port: opts.port });
      s.setTimeout(timeoutMs);
      s.once(opts.secure ? 'secureConnect' : 'connect', () => {
        s.removeListener('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
    const client = new Pop3Client(socket, timeoutMs);
    const greeting = await client.read(false);
    if (!greeting.ok) {
      client.close();
      throw new Error(`pop3: server refused connection: ${greeting.line}`);
    }
    if (!opts.secure && opts.starttls) {
      await client.startTls(opts);
    }
    return client;
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(`USER ${user}`);
    await this.command(`PASS ${password}`, false, 'PASS ****');
  }

  async stat(): Promise<{ count: number; size: number }> {
    const r = await this.command('STAT');
    const [count, size] = r.line.split(/\s+/).slice(1).map(Number);
    return { count: count ?? 0, size: size ?? 0 };
  }

  /** `[message number, UIDL]` pairs, in the server's order. */
  async uidl(): Promise<{ num: number; uidl: string }[]> {
    const r = await this.command('UIDL', true);
    return lines(r.data).flatMap((l) => {
      const [num, uidl] = l.split(/\s+/);
      return num === undefined || uidl === undefined ? [] : [{ num: Number(num), uidl }];
    });
  }

  /** The raw RFC 822 message, byte-unstuffed. */
  async retr(num: number): Promise<Buffer> {
    const r = await this.command(`RETR ${String(num)}`, true);
    return r.data;
  }

  async dele(num: number): Promise<void> {
    await this.command(`DELE ${String(num)}`);
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT');
    } finally {
      this.close();
    }
  }

  close(): void {
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  private async startTls(opts: Pop3ConnectOptions): Promise<void> {
    await this.command('STLS');
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    plain.removeAllListeners('timeout');
    this.buffer = Buffer.alloc(0);
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const s = tlsConnect({
        socket: plain,
        servername: opts.host,
        rejectUnauthorized: opts.rejectUnauthorized,
      });
      s.setTimeout(this.timeoutMs);
      s.once('secureConnect', () => {
        s.removeListener('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
    this.attach(this.socket);
  }

  private attach(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on('error', (err: Error) => {
      this.fail(err);
    });
    socket.on('timeout', () => {
      this.fail(new Error('pop3: connection timed out'));
    });
    socket.on('close', () => {
      this.fail(new Error('pop3: connection closed'));
    });
  }

  private fail(err: Error): void {
    this.closed ??= err;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(err);
  }

  /** Sends one command and waits for its response; throws on `-ERR`. */
  private async command(
    line: string,
    multiline = false,
    logAs = line,
  ): Promise<{ line: string; data: Buffer }> {
    if (this.closed !== null) {
      throw this.closed;
    }
    this.socket.write(line + '\r\n');
    const r = await this.read(multiline);
    if (!r.ok) {
      throw new Error(`pop3: ${logAs} failed: ${r.line}`);
    }
    return r;
  }

  private read(multiline: boolean): Promise<{ ok: boolean; line: string; data: Buffer }> {
    if (this.waiter !== null) {
      return Promise.reject(new Error('pop3: a command is already in flight'));
    }
    if (this.closed !== null) {
      return Promise.reject(this.closed);
    }
    return new Promise((resolve, reject) => {
      this.waiter = { multiline, resolve, reject };
      this.pump();
    });
  }

  /** Tries to complete the pending response from the buffer. */
  private pump(): void {
    const w = this.waiter;
    if (w === null) {
      return;
    }
    const eol = this.buffer.indexOf(CRLF);
    if (eol < 0) {
      return;
    }
    const line = this.buffer.subarray(0, eol).toString('utf8');
    const ok = line.startsWith('+OK');
    if (!ok || !w.multiline) {
      this.buffer = this.buffer.subarray(eol + CRLF.length);
      this.waiter = null;
      w.resolve({ ok, line, data: Buffer.alloc(0) });
      return;
    }
    // Multi-line: the body ends at the first CRLF.CRLF after the status line (the body may
    // be empty, in which case the terminator directly follows it).
    const bodyStart = eol + CRLF.length;
    const end = this.buffer.indexOf(MULTILINE_END, eol);
    if (end < 0) {
      return;
    }
    const raw = this.buffer.subarray(bodyStart, Math.max(bodyStart, end));
    this.buffer = this.buffer.subarray(end + MULTILINE_END.length);
    this.waiter = null;
    w.resolve({ ok, line, data: unstuff(raw) });
  }
}

/** Removes the byte-stuffing dot from lines that start with `..`. */
export function unstuff(raw: Buffer): Buffer {
  if (raw.length === 0) {
    return raw;
  }
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos <= raw.length) {
    const next = raw.indexOf(CRLF, pos);
    const lineEnd = next < 0 ? raw.length : next;
    let line = raw.subarray(pos, lineEnd);
    if (line.length >= 2 && line[0] === 0x2e && line[1] === 0x2e) {
      line = line.subarray(1);
    }
    parts.push(line);
    if (next < 0) {
      break;
    }
    parts.push(CRLF);
    pos = next + CRLF.length;
  }
  return Buffer.concat(parts);
}

function lines(data: Buffer): string[] {
  return data
    .toString('utf8')
    .split('\r\n')
    .filter((l) => l !== '');
}

export type Pop3ClientFactory = (opts: Pop3ConnectOptions) => Promise<Pop3Client>;

export class Pop3Mailbox implements Mailbox {
  constructor(
    private readonly config: IncomingConfig,
    private readonly state: StateStore,
    private readonly log: Log,
    private readonly connect: Pop3ClientFactory = (opts) => Pop3Client.connect(opts),
  ) {}

  async fetchNew(args: FetchNewArgs): Promise<FetchNewResult> {
    const limit = Math.min(args.limit ?? this.config.limit, this.config.limit);
    const stored = await this.state.getState('seen_uidls');
    const firstRun = stored === undefined;
    const seen = new Set<string>(Array.isArray(stored) ? stored.map(String) : []);
    const previousLast = await this.state.getState('last_uid');

    const client = await this.connect({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      starttls: this.config.starttls,
      rejectUnauthorized: this.config.reject_unauthorized,
    });
    try {
      if (this.config.user !== undefined && this.config.password !== undefined) {
        await client.login(this.config.user, this.config.password);
      }
      const listing = await client.uidl();
      const current = new Set(listing.map((e) => e.uidl));

      if (firstRun && this.config.initial === 'none') {
        this.log(`pop3: no cursor, skipping ${String(listing.length)} existing messages`);
        await this.saveSeen(current, current, previousLast);
        await client.quit();
        return { emails: [], last_uid: typeof previousLast === 'string' ? previousLast : null };
      }

      const fresh = listing
        .filter((e) => !seen.has(e.uidl))
        .sort((a, b) => a.num - b.num)
        .slice(0, limit);
      const emails: EmailMessage[] = [];
      for (const entry of fresh) {
        const source = await client.retr(entry.num);
        emails.push(
          await parseMessage(source, { uid: entry.uidl, maxBodyChars: this.config.max_body_chars }),
        );
        if (this.config.delete_after_fetch) {
          await client.dele(entry.num);
        }
      }
      // Deletions are committed by QUIT; only record the batch as seen once that succeeded.
      await client.quit();
      if (this.config.delete_after_fetch) {
        for (const entry of fresh) {
          current.delete(entry.uidl);
        }
      }

      const delivered = new Set([...seen, ...fresh.map((e) => e.uidl)]);
      const last = fresh.at(-1)?.uidl ?? previousLast;
      const lastUid = typeof last === 'string' ? last : null;
      await this.saveSeen(delivered, current, lastUid);
      this.log(
        `pop3: fetch_new -> ${String(emails.length)} of ${String(listing.length)} on server`,
      );
      return { emails, last_uid: lastUid };
    } catch (err) {
      client.close();
      throw err;
    }
  }

  markRead(_args: MarkReadArgs): Promise<MarkReadResult> {
    this.log('pop3: mark_read is not supported (POP3 has no flags)');
    return Promise.resolve({ ok: false, supported: false });
  }

  /**
   * Remembers `delivered ∩ current`: a UIDL that left the server can never come back as
   * new, so forgetting it keeps the list bounded by the mailbox size.
   */
  private async saveSeen(
    delivered: Set<string>,
    current: Set<string>,
    last: unknown,
  ): Promise<void> {
    let keep = [...delivered].filter((u) => current.has(u));
    if (keep.length > MAX_SEEN) {
      keep = keep.slice(keep.length - MAX_SEEN);
    }
    await this.state.putState('seen_uidls', keep);
    if (typeof last === 'string') {
      await this.state.putState('last_uid', last);
    }
  }
}
