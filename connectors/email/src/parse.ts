/** Raw RFC 822 bytes → `EmailMessage`, via mailparser. */
import { createHash } from 'node:crypto';

import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

import type { EmailMessage } from './types.js';

export interface ParseOptions {
  uid: number | string;
  maxBodyChars: number;
}

export async function parseMessage(source: Buffer, opts: ParseOptions): Promise<EmailMessage> {
  const mail = await simpleParser(source, { skipHtmlToText: false, skipImageLinks: true });
  return toEmailMessage(mail, source, opts);
}

export function toEmailMessage(mail: ParsedMail, source: Buffer, opts: ParseOptions): EmailMessage {
  const from = firstAddress(mail.from);
  const text = (mail.text ?? (mail.html === false ? '' : htmlToText(mail.html))).trimEnd();
  const body = text.length > opts.maxBodyChars ? text.slice(0, opts.maxBodyChars) : text;
  const replyTo = firstAddress(mail.replyTo);
  return {
    uid: opts.uid,
    message_id: mail.messageId ?? fallbackMessageId(source),
    from: from.address,
    from_name: from.name,
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    reply_to: replyTo.address === '' ? null : replyTo.address,
    subject: mail.subject ?? '',
    date:
      mail.date === undefined || Number.isNaN(mail.date.getTime()) ? null : mail.date.toISOString(),
    body,
    truncated: body.length < text.length,
    in_reply_to: mail.inReplyTo ?? null,
    references:
      mail.references === undefined
        ? []
        : Array.isArray(mail.references)
          ? mail.references
          : [mail.references],
    attachments: mail.attachments
      .filter((a) => !a.related)
      .map((a) => ({
        filename: a.filename ?? null,
        content_type: a.contentType,
        size: a.size,
      })),
  };
}

function firstAddress(obj: AddressObject | undefined): { address: string; name: string } {
  const first = obj?.value[0];
  return {
    address: (first?.address ?? '').toLowerCase(),
    name: first?.name ?? '',
  };
}

function addresses(obj: AddressObject | AddressObject[] | undefined): string[] {
  if (obj === undefined) {
    return [];
  }
  const list = Array.isArray(obj) ? obj : [obj];
  return list.flatMap((o) =>
    o.value.flatMap((v) => (v.address === undefined ? [] : [v.address.toLowerCase()])),
  );
}

/** A stable stand-in for a missing Message-ID header, derived from the raw bytes. */
function fallbackMessageId(source: Buffer): string {
  return `<sha256-${createHash('sha256').update(source).digest('hex').slice(0, 32)}@missing-message-id>`;
}

/** A rough plain-text rendering for HTML-only mails; good enough for a model to read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
