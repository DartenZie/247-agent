/** Shared shapes: the event payload one mail becomes, and the small core-state facade. */
import type { JsonValue } from '@247-agent/connector-sdk';

/**
 * One received mail as it lands in an `email.received` event payload. `from` is the bare
 * lower-cased address so a task filter like `payload.from == 'x@y'` works; `body` is the
 * text part (or a plain-text rendering of the HTML part) cut to `max_body_chars`.
 * Attachment contents are not included, only their metadata.
 */
export interface EmailMessage {
  /** IMAP UID (number) or POP3 UIDL (string). */
  uid: number | string;
  message_id: string;
  from: string;
  from_name: string;
  to: string[];
  cc: string[];
  reply_to: string | null;
  subject: string;
  /** ISO 8601, from the Date header. */
  date: string | null;
  body: string;
  truncated: boolean;
  in_reply_to: string | null;
  references: string[];
  attachments: { filename: string | null; content_type: string; size: number }[];
  [key: string]: JsonValue;
}

export interface FetchNewArgs {
  folder?: string | undefined;
  /** IMAP: the UID cursor. POP3 ignores it (see `Pop3Mailbox`). */
  since_uid?: number | string | null | undefined;
  limit?: number | undefined;
}

export interface FetchNewResult {
  emails: EmailMessage[];
  /** The cursor to pass back as `since_uid` next time. */
  last_uid: number | string | null;
  [key: string]: JsonValue;
}

export interface MarkReadArgs {
  folder?: string | undefined;
  uid?: number | string | undefined;
  message_id?: string | undefined;
}

export interface MarkReadResult {
  ok: boolean;
  /** False for POP3, which has no flags. */
  supported: boolean;
  [key: string]: JsonValue;
}

/** What `fetch_new` and `mark_read` need from a mailbox, whatever the protocol. */
export interface Mailbox {
  fetchNew(args: FetchNewArgs): Promise<FetchNewResult>;
  markRead(args: MarkReadArgs): Promise<MarkReadResult>;
}

/** The connector's own namespace in the core's state KV (`rt.core` implements it). */
export interface StateStore {
  getState(key: string): Promise<JsonValue | undefined>;
  putState(key: string, value: JsonValue): Promise<void>;
}

export type Log = (line: string) => void;
