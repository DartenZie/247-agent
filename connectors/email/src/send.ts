/** Outgoing mail over SMTP with nodemailer. The configured footer is appended to every message. */
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';

import type { OutgoingConfig } from './config.js';

export interface SendArgs {
  to: string | string[];
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  reply_to?: string | undefined;
  /** Message-ID of the mail this answers; also added to References. */
  in_reply_to?: string | undefined;
  references?: string | string[] | undefined;
  attachments?:
    | {
        filename: string;
        content: string;
        /** `utf8` (default) or `base64`. */
        encoding?: 'utf8' | 'base64' | undefined;
        content_type?: string | undefined;
      }[]
    | undefined;
}

export interface SendResult {
  message_id: string;
  accepted: string[];
  rejected: string[];
  [key: string]: string | string[];
}

/** The nodemailer message for `args`, footer included. Pure, so it is testable without SMTP. */
export function buildMessage(config: OutgoingConfig, args: SendArgs): SendMailOptions {
  if (args.text === undefined && args.html === undefined) {
    throw new Error('send: pass text, html or both');
  }
  const references = [
    ...(args.references === undefined
      ? []
      : Array.isArray(args.references)
        ? args.references
        : [args.references]),
    ...(args.in_reply_to === undefined ? [] : [args.in_reply_to]),
  ];
  const text = args.text === undefined ? undefined : appendTextFooter(args.text, config.footer);
  const htmlFooter =
    config.footer_html ??
    (config.footer === undefined ? undefined : textFooterAsHtml(config.footer));
  const html = args.html === undefined ? undefined : appendHtmlFooter(args.html, htmlFooter);
  return {
    from: config.from,
    to: args.to,
    ...(args.cc === undefined ? {} : { cc: args.cc }),
    ...(args.bcc === undefined ? {} : { bcc: args.bcc }),
    subject: args.subject,
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
    ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
    ...(args.in_reply_to === undefined ? {} : { inReplyTo: args.in_reply_to }),
    ...(references.length === 0 ? {} : { references: [...new Set(references)] }),
    ...(args.attachments === undefined
      ? {}
      : {
          attachments: args.attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.content, a.encoding ?? 'utf8'),
            ...(a.content_type === undefined ? {} : { contentType: a.content_type }),
          })),
        }),
  };
}

/** `body`, one blank line, the footer; trailing whitespace on either side is normalised. */
export function appendTextFooter(body: string, footer: string | undefined): string {
  const f = footer?.replace(/\s+$/, '') ?? '';
  if (f === '') {
    return body;
  }
  return body.replace(/\s+$/, '') + '\n\n' + f + '\n';
}

export function appendHtmlFooter(html: string, footerHtml: string | undefined): string {
  if (footerHtml === undefined || footerHtml.trim() === '') {
    return html;
  }
  const closing = /<\/body>/i.exec(html);
  if (closing !== null) {
    return html.slice(0, closing.index) + footerHtml + html.slice(closing.index);
  }
  return html + footerHtml;
}

/** The text footer as an HTML paragraph, escaped, with line breaks kept. */
export function textFooterAsHtml(footer: string): string {
  const escaped = footer
    .replace(/\s+$/, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '<br>\n');
  return `<p class="footer">${escaped}</p>`;
}

export type SmtpTransport = Pick<Transporter, 'sendMail'>;

export function createSmtpTransport(config: OutgoingConfig): SmtpTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && config.starttls,
    ...(config.user === undefined || config.password === undefined
      ? {}
      : { auth: { user: config.user, pass: config.password } }),
    tls: { rejectUnauthorized: config.reject_unauthorized },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });
}

export async function sendMail(
  transport: SmtpTransport,
  message: SendMailOptions,
): Promise<SendResult> {
  const info = (await transport.sendMail(message)) as {
    messageId?: string;
    accepted?: (string | { address: string })[];
    rejected?: (string | { address: string })[];
  };
  const addr = (a: string | { address: string }): string => (typeof a === 'string' ? a : a.address);
  return {
    message_id: info.messageId ?? '',
    accepted: (info.accepted ?? []).map(addr),
    rejected: (info.rejected ?? []).map(addr),
  };
}
