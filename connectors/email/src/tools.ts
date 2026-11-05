import { z } from 'zod';

import { defineTool, toJson, type ToolDef } from '@247-agent/connector-sdk';

import type { OutgoingConfig } from './config.js';
import { buildMessage, createSmtpTransport, sendMail, type SmtpTransport } from './send.js';
import type { Mailbox } from './types.js';

const address = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export interface EmailToolDeps {
  /** Unset without an `incoming` config: `fetch_new` and `mark_read` then fail. */
  mailbox: Mailbox | undefined;
  /** Unset without an `outgoing` config: `send` then fails. */
  outgoing: OutgoingConfig | undefined;
  log: (line: string) => void;
}

/** The ops this connector registers, in the order `tools/list` returns them. */
export function emailTools({ mailbox, outgoing, log }: EmailToolDeps): ToolDef[] {
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
        "Messages newer than the cursor since_uid: IMAP UIDs above it, or POP3 messages not handled yet (passing a batch's last_uid back marks it handled). Returns {emails, last_uid}.",
      input: {
        folder: z.string().optional(),
        since_uid: z.union([z.number(), z.string(), z.null()]).optional(),
        limit: z.number().int().min(1).optional(),
      },
      handler: async (args) => toJson(await requireMailbox().fetchNew(args)),
    }),
    defineTool({
      name: 'mark_read',
      description: 'Sets the \\Seen flag on one message (IMAP only) by uid or message_id.',
      input: {
        folder: z.string().optional(),
        uid: z.union([z.number(), z.string()]).optional(),
        message_id: z.string().optional(),
      },
      handler: async (args) => toJson(await requireMailbox().markRead(args)),
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
        log(
          `email: sent "${args.subject}" to ${String(result.accepted.length)} recipient(s)` +
            (result.rejected.length > 0 ? `, ${String(result.rejected.length)} rejected` : ''),
        );
        return result;
      },
    }),
  ];
}
