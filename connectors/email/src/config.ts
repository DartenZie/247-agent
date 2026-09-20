/**
 * The connector's config, as the core passes it in `OA_CONFIG_JSON` (secrets already
 * rendered). `incoming` (IMAP or POP3) and `outgoing` (SMTP) are each optional so a
 * manifest can be receive-only or send-only; at least one must be present. `user` and
 * `password` at the top level are inherited by both sides when they do not set their own.
 */
import { z } from 'zod';

const port = z.number().int().min(1).max(65535);

const endpoint = {
  host: z.string().min(1),
  port: port.optional(),
  /** Implicit TLS from the first byte (993/995/465). Defaults from the port. */
  secure: z.boolean().optional(),
  /** On a plain-text port, require an upgrade (STARTTLS / STLS) before logging in. */
  starttls: z.boolean().default(true),
  /** Verify the server certificate. Only switch off for a private test server. */
  reject_unauthorized: z.boolean().default(true),
  user: z.string().optional(),
  password: z.string().optional(),
};

const incomingSchema = z.object({
  ...endpoint,
  protocol: z.enum(['imap', 'pop3']).default('imap'),
  /** IMAP only; POP3 has a single mailbox. */
  folder: z.string().default('INBOX'),
  /**
   * What the first `fetch_new` with no cursor does: `none` marks everything currently in
   * the mailbox as seen and returns nothing (safe for an existing mailbox), `all`
   * returns it all.
   */
  initial: z.enum(['none', 'all']).default('none'),
  /** Upper bound of messages returned by one `fetch_new`. */
  limit: z.number().int().min(1).max(1000).default(50),
  /** The `body` field is cut to this many characters. */
  max_body_chars: z.number().int().min(1).default(100_000),
  /** POP3 only: delete a message on the server once it was fetched. */
  delete_after_fetch: z.boolean().default(false),
});

const outgoingSchema = z.object({
  ...endpoint,
  /** The `From:` header, `Name <addr>` or a bare address. */
  from: z.string().min(1),
  /** Appended to the text body of every mail, separated by a blank line. */
  footer: z.string().optional(),
  /** Appended to the HTML body; derived from `footer` when unset. */
  footer_html: z.string().optional(),
});

const schema = z
  .object({
    user: z.string().optional(),
    password: z.string().optional(),
    incoming: incomingSchema.optional(),
    outgoing: outgoingSchema.optional(),
  })
  .refine((c) => c.incoming !== undefined || c.outgoing !== undefined, {
    message: 'config needs "incoming" (IMAP/POP3), "outgoing" (SMTP) or both',
  });

export type IncomingConfig = z.infer<typeof incomingSchema> & Resolved;
export type OutgoingConfig = z.infer<typeof outgoingSchema> & Resolved;

interface Resolved {
  port: number;
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
}

export interface EmailConfig {
  incoming: IncomingConfig | undefined;
  outgoing: OutgoingConfig | undefined;
}

const DEFAULT_PORTS = {
  imap: { secure: 993, plain: 143 },
  pop3: { secure: 995, plain: 110 },
  smtp: { secure: 465, plain: 587 },
} as const;

const IMPLICIT_TLS_PORTS = new Set<number>([993, 995, 465]);

/** Parses the raw config object; throws a readable error listing every problem. */
export function parseConfig(raw: unknown): EmailConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`,
    );
    throw new Error(`invalid email connector config:\n  ${lines.join('\n  ')}`);
  }
  const c = result.data;
  return {
    incoming:
      c.incoming === undefined
        ? undefined
        : { ...c.incoming, ...resolveEndpoint(c.incoming, DEFAULT_PORTS[c.incoming.protocol], c) },
    outgoing:
      c.outgoing === undefined
        ? undefined
        : { ...c.outgoing, ...resolveEndpoint(c.outgoing, DEFAULT_PORTS.smtp, c) },
  };
}

function resolveEndpoint(
  e: {
    port?: number | undefined;
    secure?: boolean | undefined;
    user?: string | undefined;
    password?: string | undefined;
  },
  defaults: { secure: number; plain: number },
  shared: { user?: string | undefined; password?: string | undefined },
): Resolved {
  const secure = e.secure ?? (e.port === undefined ? true : IMPLICIT_TLS_PORTS.has(e.port));
  return {
    port: e.port ?? (secure ? defaults.secure : defaults.plain),
    secure,
    user: e.user ?? shared.user,
    password: e.password ?? shared.password,
  };
}
