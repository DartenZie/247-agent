/**
 * A fake email connector: `fetch_new` returns the mails listed in the manifest's `config`
 * with a uid above `since_uid`; `mark_read` is a no-op. Never touches the network.
 */
import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '../../../connector-sdk/src/index.ts';

interface Mail {
  uid: number;
  message_id: string;
  from: string;
  subject: string;
  body: string;
}

await runConnector({
  tools: (rt) => {
    const mails = (rt.env.config.mails ?? []) as unknown as Mail[];
    return [
      defineTool({
        name: 'fetch_new',
        input: {
          folder: z.string().optional(),
          since_uid: z.union([z.number(), z.null()]).optional(),
        },
        handler: (args) => {
          const since = args.since_uid ?? 0;
          const fresh = mails.filter((m) => m.uid > since);
          const last = fresh.reduce((max, m) => Math.max(max, m.uid), since);
          rt.log(
            `fetch_new folder=${args.folder ?? 'INBOX'} since=${String(since)} -> ${String(fresh.length)}`,
          );
          return { emails: fresh as unknown as JsonValue, last_uid: last };
        },
      }),
      defineTool({
        name: 'mark_read',
        input: { message_id: z.string() },
        handler: () => ({ ok: true }),
      }),
    ];
  },
});
