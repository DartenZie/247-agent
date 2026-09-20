/**
 * IMAP mailbox on `imapflow`. One connection per call, so the process stays stateless.
 *
 * Cursor: the highest UID delivered so far. The caller normally passes it back as
 * `since_uid` (the reference workflow keeps it in task state); when it is absent the
 * connector's own `last_uid` state entry is used, and both are kept in step. UIDs only
 * mean something for one UIDVALIDITY value, so that is stored too and the cursor is reset
 * when the server reports a new one.
 */
import { ImapFlow } from 'imapflow';

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

export const defaultImapClientFactory: ImapClientFactory = (config) =>
  new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user === undefined || config.password === undefined
      ? {}
      : { auth: { user: config.user, pass: config.password } }),
    tls: { rejectUnauthorized: config.reject_unauthorized },
    logger: false,
    disableAutoIdle: true,
  });

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
      await this.state.putState('last_uid', last);
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
    const candidate = given ?? (await this.state.getState('last_uid'));
    if (candidate === undefined || candidate === null || candidate === '') {
      return null;
    }
    const n = Number(candidate);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `fetch_new: since_uid must be a non-negative integer, got ${JSON.stringify(candidate)}`,
      );
    }
    return n;
  }

  private async withMailbox<T>(
    folder: string,
    fn: (client: ImapClient, mailbox: { uidValidity: bigint; uidNext: number }) => Promise<T>,
  ): Promise<T> {
    const client = this.clientFactory(this.config);
    await client.connect();
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
