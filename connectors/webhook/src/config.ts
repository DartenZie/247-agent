/**
 * The connector's config, as the core passes it in `OA_CONFIG_JSON` (secrets already
 * rendered). One listener (TCP or a Unix socket) and a list of routes; each route names
 * the event it emits and how a request proves it is genuine.
 */
import { z } from 'zod';

/** One event type segment, as the core accepts it (`packages/core/src/expr/glob.ts`). */
const SEGMENT = /^[a-z0-9_-]+$/;
const MAX_SEGMENTS = 8;

const eventType = z
  .string()
  .trim()
  .min(1)
  .refine(
    (t) => t.split('.').length <= MAX_SEGMENTS && t.split('.').every((s) => SEGMENT.test(s)),
    { message: 'an event type is dot-separated segments of a-z, 0-9, "_" and "-"' },
  );

const headerName = z
  .string()
  .trim()
  .min(1)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'not a valid HTTP header name')
  .transform((h) => h.toLowerCase());

const secret = z.string().min(1, 'the secret is empty (is the secret set in the backend?)');

/**
 * How a route checks a request. `github` and `gitlab` are presets of `hmac` and `token`
 * with the headers those services send; `none` accepts anything and is meant for a
 * listener only a trusted proxy can reach.
 */
const Verify = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('github'), secret }),
  z.strictObject({ kind: z.literal('gitlab'), token: secret }),
  z.strictObject({
    kind: z.literal('hmac'),
    secret,
    /** The header carrying the signature of the raw body. */
    header: headerName,
    algorithm: z.enum(['sha1', 'sha256', 'sha512']).default('sha256'),
    encoding: z.enum(['hex', 'base64']).default('hex'),
    /** Stripped from the header value before comparing (`sha256=`). */
    prefix: z.string().default(''),
  }),
  z.strictObject({
    kind: z.literal('token'),
    token: secret,
    header: headerName.default('authorization'),
    /** Expected before the token (`Bearer` → `Authorization: Bearer <token>`); empty for none. */
    scheme: z.string().default('Bearer'),
  }),
  z.strictObject({ kind: z.literal('none') }),
]);

export type VerifyConfig = z.infer<typeof Verify>;

const Route = z.strictObject({
  /** The request path this route answers (exact match, query string ignored). */
  path: z
    .string()
    .trim()
    .regex(/^\/[^?#\s]*$/, 'a path starts with "/" and has no query string'),
  /** Names the route in logs and dedup keys; defaults to the path without its slashes. */
  name: z
    .string()
    .regex(/^[a-z0-9_-]+$/, 'route names are a-z, 0-9, "_" and "-"')
    .optional(),
  /** The event type emitted, or its prefix when `type_header` is set. */
  event: eventType,
  /** Appends `.<value of this header>` to `event` (`X-GitHub-Event: push` → `github.push`). */
  type_header: headerName.optional(),
  /** A header whose value identifies the delivery; the event's dedup key, so a retry is dropped. */
  dedup_header: headerName.optional(),
  verify: Verify,
  /** HTTP methods accepted. */
  methods: z
    .array(z.string().trim().toUpperCase())
    .min(1)
    .default(['POST'])
    .transform((m) => [...new Set(m)]),
});

export type RouteConfig = z.infer<typeof Route> & { name: string };

const Listen = z.union([
  z.strictObject({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(8787),
  }),
  z.strictObject({
    /** A Unix socket for a reverse proxy; a stale file is replaced at start. */
    path: z.string().min(1),
    /** Octal permission bits of the socket file. */
    mode: z
      .string()
      .regex(/^0?[0-7]{3}$/, 'an octal mode like "0660"')
      .default('0660'),
  }),
]);

const schema = z
  .strictObject({
    listen: Listen.prefault({}),
    routes: z.array(Route).min(1, 'at least one route is needed'),
    /** Largest accepted body in bytes; bigger requests get 413. */
    max_body: z
      .number()
      .int()
      .min(1)
      .default(1024 * 1024),
    /**
     * Request headers left out of the event payload, on top of the ones that always are
     * (`authorization`, `cookie`, `proxy-authorization` and each route's signature or
     * token header).
     */
    drop_headers: z.array(headerName).default([]),
    /** Trust `X-Forwarded-For` for the `remote` field (only behind a proxy you run). */
    trust_proxy: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.routes.forEach((r, i) => {
      if (seen.has(r.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'path'],
          message: `"${r.path}" is routed twice`,
        });
      }
      seen.add(r.path);
      if (r.type_header !== undefined && r.event.split('.').length >= MAX_SEGMENTS) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'event'],
          message: `with type_header the event gets one more segment; at most ${String(MAX_SEGMENTS - 1)} here`,
        });
      }
      if (r.path === '/healthz') {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'path'],
          message: '"/healthz" is the health endpoint',
        });
      }
    });
  });

export type WebhookConfig = Omit<z.infer<typeof schema>, 'routes'> & { routes: RouteConfig[] };

/** Parses the raw config object; throws a readable error listing every problem. */
export function parseConfig(raw: unknown): WebhookConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`,
    );
    throw new Error(`invalid webhook connector config:\n  ${lines.join('\n  ')}`);
  }
  const data = result.data;
  return { ...data, routes: data.routes.map((r) => ({ ...r, name: r.name ?? routeName(r.path) })) };
}

/** `/hooks/github` → `hooks-github`; `/` → `root`. */
export function routeName(path: string): string {
  const name = path
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name === '' ? 'root' : name;
}

/** The header a route's check reads, which never goes into the event. */
export function secretHeader(verify: VerifyConfig): string | undefined {
  switch (verify.kind) {
    case 'github':
      return 'x-hub-signature-256';
    case 'gitlab':
      return 'x-gitlab-token';
    case 'hmac':
    case 'token':
      return verify.header;
    case 'none':
      return undefined;
  }
}
