/**
 * The email connector: IMAP or POP3 in, SMTP out. Ops: `fetch_new`, `mark_read`, `send`.
 * Spawned by the core with the manifest's `config` in `OA_CONFIG_JSON`; see README.md.
 */
import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '@247-agent/connector-sdk';

import { parseConfig } from './config.js';
import { ImapMailbox } from './imap.js';
import { Pop3Mailbox } from './pop3.js';
import { buildMessage, createSmtpTransport, sendMail, type SmtpTransport } from './send.js';
import type { Mailbox } from './types.js';

const address = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

await runConnector({
  version: '0.1.0',
  tools: (rt) => {
    const config = parseConfig(rt.env.config);
    const incoming = config.incoming;
    const outgoing = config.outgoing;
    rt.log(
      `email: incoming=${incoming === undefined ? 'off' : `${incoming.protocol}://${incoming.host}:${String(incoming.port)}`} ` +
        `outgoing=${outgoing === undefined ? 'off' : `smtp://${outgoing.host}:${String(outgoing.port)}`}`,
    );

    let mailbox: Mailbox | undefined;
    if (incoming !== undefined) {
      mailbox =
        incoming.protocol === 'pop3'
          ? new Pop3Mailbox(incoming, rt.core, rt.log)
          : new ImapMailbox(incoming, rt.core, rt.log);
    }
    const requireMailbox = (): Mailbox => {
      if (mailbox === undefined) {
        throw new Error(
          'this connector has no "incoming" config; fetch_new/mark_read are unavailable',
        );
      }
      return mailbox;
    };

    let transport: SmtpTransport | undefined;
    const requireTransport = (): SmtpTransport => {
      if (outgoing === undefined) {
        throw new Error('this connector has no "outgoing" config; send is unavailable');
      }
      transport ??= createSmtpTransport(outgoing);
      return transport;
    };

    return [
      defineTool({
        name: 'fetch_new',
        description:
          'Messages newer than the cursor: IMAP UIDs above since_uid, or POP3 messages not delivered before. Returns {emails, last_uid}.',
        input: {
          folder: z.string().optional(),
          since_uid: z.union([z.number(), z.string(), z.null()]).optional(),
          limit: z.number().int().min(1).optional(),
        },
        handler: async (args) => (await requireMailbox().fetchNew(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'mark_read',
        description: 'Sets the \\Seen flag on one message (IMAP only) by uid or message_id.',
        input: {
          folder: z.string().optional(),
          uid: z.union([z.number(), z.string()]).optional(),
          message_id: z.string().optional(),
        },
        handler: async (args) => (await requireMailbox().markRead(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'send',
        description:
          'Sends a mail over SMTP from the configured address. The configured footer is appended automatically.',
        input: {
          to: address,
          cc: address.optional(),
          bcc: address.optional(),
          subject: z.string(),
          text: z.string().optional(),
          html: z.string().optional(),
          reply_to: z.string().optional(),
          in_reply_to: z.string().optional(),
          references: z.union([z.string(), z.array(z.string())]).optional(),
          attachments: z
            .array(
              z.object({
                filename: z.string().min(1),
                content: z.string(),
                encoding: z.enum(['utf8', 'base64']).optional(),
                content_type: z.string().optional(),
              }),
            )
            .optional(),
        },
        handler: async (args) => {
          if (outgoing === undefined) {
            throw new Error('this connector has no "outgoing" config; send is unavailable');
          }
          const message = buildMessage(outgoing, args);
          const result = await sendMail(requireTransport(), message);
          rt.log(
            `email: sent "${args.subject}" to ${String(result.accepted.length)} recipient(s)` +
              (result.rejected.length > 0 ? `, ${String(result.rejected.length)} rejected` : ''),
          );
          return result;
        },
      }),
    ];
  },
});
