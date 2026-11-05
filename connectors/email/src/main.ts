/**
 * The email connector: IMAP or POP3 in, SMTP out. Ops: `fetch_new`, `mark_read`, `send`
 * (`tools.ts`). Spawned by the core with the manifest's `config` in `OA_CONFIG_JSON`; see
 * README.md.
 */
import { runConnector } from '@247-agent/connector-sdk';

import { parseConfig } from './config.js';
import { isTransientMailError } from './errors.js';
import { ImapMailbox } from './imap.js';
import { Pop3Mailbox } from './pop3.js';
import { emailTools } from './tools.js';
import type { Mailbox } from './types.js';

await runConnector({
  version: '0.1.0',
  transient: isTransientMailError,
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
    return emailTools({ mailbox, outgoing, log: rt.log });
  },
});
