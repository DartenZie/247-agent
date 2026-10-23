/**
 * IMAP mailbox on `imapflow`. One connection per call, so the process stays stateless.
 *
 * Cursor: the highest UID delivered so far, owned by the caller. A task keeps it with
 * `state_updates`, which commit only with a successful run, and passes it back as
 * `since_uid`; a failed run passes the old one, so its mail comes back. The connector
 * keeps no cursor of its own: one it moved on every call would skip mail a failed run, or
 * another task on the same mailbox, has not handled. Absent or `null` means no cursor.
 * UIDs only mean something for one UIDVALIDITY value, so that is stored and the cursor is
 * reset when the server reports a new one.
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow';

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

/** The slice of `ImapFlow` this module uses, so tests can substitute a fake. */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  mailbox: { uidValidity: bigint; uidNext: number } | false;
  search(
    query: { uid?: string; header?: Record<string, string> },
    options: { uid: true },
  ): Promise<number[] | false | undefined>;
  fetchAll(
    range: number[],
    query: { uid: true; source: true },
    options: { uid: true },
  ): Promise<{ uid: number; source?: Buffer | undefined }[]>;
  messageFlagsAdd(range: number[], flags: string[], options: { uid: true }): Promise<boolean>;
}

export type ImapClientFactory = (config: IncomingConfig) => ImapClient;

/**
 * `doSTARTTLS: true` makes imapflow fail before login when a plain-text server offers no
 * STARTTLS; left unset it upgrades only when offered, as nodemailer does with `starttls`
 * off. Without it `starttls: true` was not enforced for IMAP (found by the smoke run).
 */
export function imapFlowOptions(config: IncomingConfig): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(!config.secure && config.starttls ? { doSTARTTLS: true } : {}),
    ...(config.user === undefined || config.password === undefined
      ? {}
      : { auth: { user: config.user, pass: config.password } }),
    tls: { rejectUnauthorized: config.reject_unauthorized },
    logger: false,
    disableAutoIdle: true,
  };
}

export const defaultImapClientFactory: ImapClientFactory = (config) =>
  new ImapFlow(imapFlowOptions(config));

/** `search` yields `false`/`undefined` for no match on some servers. */
function asList(found: number[] | false | undefined): number[] {
  return Array.isArray(found) ? found : [];
}

export class ImapMailbox implements Mailbox {
  constructor(
    private readonly config: IncomingConfig,
    private readonly state: StateStore,
    private readonly log: Log,
    private readonly clientFactory: ImapClientFactory = defaultImapClientFactory,
  ) {}

  async fetchNew(args: FetchNewArgs): Promise<FetchNewResult> {
    const folder = args.folder ?? this.config.folder;
    const limit = Math.min(args.limit ?? this.config.limit, this.config.limit);
    return this.withMailbox(folder, async (client, mailbox) => {
      const validity = mailbox.uidValidity.toString();
      if (args.since_uid === undefined) {
        this.log(
          'imap: fetch_new without since_uid has no cursor; pass last_uid back as since_uid',
        );
      }
      let since = await this.resolveCursor(args.since_uid, validity);
      if (since === null) {
        // First run in this mailbox (or UIDVALIDITY changed).
        if (this.config.initial === 'none') {
          since = mailbox.uidNext - 1;
          this.log(`imap: no cursor, skipping ${String(since)} existing messages in ${folder}`);
        } else {
          since = 0;
        }
      }
      const found = asList(await client.search({ uid: `${String(since + 1)}:*` }, { uid: true }));
      // `n:*` also matches the highest UID when n is past it, so filter on our side.
      const uids = found
        .filter((u) => u > since)
        .sort((a, b) => a - b)
        .slice(0, limit);
      const emails: EmailMessage[] = [];
      if (uids.length > 0) {
        const messages = await client.fetchAll(uids, { uid: true, source: true }, { uid: true });
        messages.sort((a, b) => a.uid - b.uid);
        for (const m of messages) {
          if (m.source === undefined) {
            this.log(`imap: uid ${String(m.uid)} came back without a body, skipping`);
            continue;
          }
          emails.push(
            await parseMessage(m.source, { uid: m.uid, maxBodyChars: this.config.max_body_chars }),
          );
        }
      }
      const last = uids.at(-1) ?? since;
      await this.state.putState('uidvalidity', validity);
      this.log(
        `imap: fetch_new folder=${folder} since=${String(since)} -> ${String(emails.length)} (last_uid=${String(last)})`,
      );
      return { emails, last_uid: last };
    });
  }

  async markRead(args: MarkReadArgs): Promise<MarkReadResult> {
    const folder = args.folder ?? this.config.folder;
    return this.withMailbox(folder, async (client) => {
      let uids: number[];
      if (args.uid !== undefined) {
        const uid = typeof args.uid === 'number' ? args.uid : Number(args.uid);
        if (!Number.isInteger(uid) || uid < 1) {
          throw new Error(`mark_read: invalid IMAP uid ${JSON.stringify(args.uid)}`);
        }
        uids = [uid];
      } else if (args.message_id !== undefined) {
        uids = asList(
          await client.search({ header: { 'message-id': args.message_id } }, { uid: true }),
        );
      } else {
        throw new Error('mark_read: pass uid or message_id');
      }
      if (uids.length === 0) {
        return { ok: false, supported: true };
      }
      const ok = await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      return { ok, supported: true };
    });
  }

  /** The cursor to search from, or `null` when there is none for this UIDVALIDITY. */
  private async resolveCursor(
    given: number | string | null | undefined,
    validity: string,
  ): Promise<number | null> {
    const raw = await this.state.getState('uidvalidity');
    const stored = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
    if (stored !== undefined && stored !== validity) {
      this.log(`imap: UIDVALIDITY changed ${stored} -> ${validity}, cursor reset`);
      return null;
    }
    if (given === undefined || given === null || given === '') {
      return null;
    }
    const n = Number(given);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `fetch_new: since_uid must be a non-negative integer, got ${JSON.stringify(given)}`,
      );
    }
    return n;
  }

  private async withMailbox<T>(
    folder: string,
    fn: (client: ImapClient, mailbox: { uidValidity: bigint; uidNext: number }) => Promise<T>,
  ): Promise<T> {
    const client = this.clientFactory(this.config);
    try {
      await client.connect();
    } catch (err) {
      // imapflow leaves the socket open when connect fails (a refused STARTTLS, a bad
      // login); its idle timeout then raises an 'error' nobody listens for.
      client.close();
      throw err;
    }
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        if (client.mailbox === false) {
          throw new Error(`imap: could not open folder ${folder}`);
        }
        return await fn(client, client.mailbox);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}
