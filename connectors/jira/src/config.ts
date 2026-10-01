/**
 * The connector's config, as the core passes it in `OA_CONFIG_JSON` (secrets already
 * rendered). One Jira site, one way to authenticate, and the projects the ops may touch.
 */
import { z } from 'zod';

const secret = z.string().min(1, 'empty (is the secret set in the backend?)');

const schema = z
  .strictObject({
    /** The site: `https://acme.atlassian.net`, or a Data Center base URL. */
    base_url: z.url().transform((v) => v.replace(/\/+$/, '')),
    /**
     * `cloud`: REST API v3, rich text as Atlassian Document Format (converted from and to
     * plain text here), search through `/search/jql`. `datacenter`: REST API v2 (Server
     * and Data Center), rich text as wiki markup strings. Default from `base_url`.
     */
    deployment: z.enum(['cloud', 'datacenter']).optional(),
    /** Cloud: the account's email and an API token (id.atlassian.com → Security → API tokens). */
    email: z.string().min(1).optional(),
    api_token: secret.optional(),
    /** Data Center: a personal access token, sent as `Authorization: Bearer`. */
    token: secret.optional(),
    /** Data Center without tokens: basic auth. */
    username: z.string().min(1).optional(),
    password: secret.optional(),
    /** Project keys the ops may touch; the first is the default for `create_issue`. */
    projects: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Z][A-Z0-9_]+$/, 'a project key like SITE'),
      )
      .min(1, 'name at least one project')
      .transform((p) => [...new Set(p)]),
    /** Timeout per API call in milliseconds. */
    timeout: z.number().int().min(1).default(30_000),
    /** Upper bound of a description or comment returned, in characters. */
    max_text: z.number().int().min(1).default(50_000),
  })
  .superRefine((c, ctx) => {
    const schemes = [
      c.email !== undefined || c.api_token !== undefined,
      c.token !== undefined,
      c.username !== undefined || c.password !== undefined,
    ].filter(Boolean).length;
    if (schemes !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'set exactly one of: email + api_token, token, or username + password',
      });
      return;
    }
    if ((c.email === undefined) !== (c.api_token === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['api_token'],
        message: 'email and api_token go together',
      });
    }
    if ((c.username === undefined) !== (c.password === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'username and password go together',
      });
    }
  });

export interface JiraConfig extends Omit<z.infer<typeof schema>, 'deployment'> {
  deployment: 'cloud' | 'datacenter';
}

/** Parses the raw config object; throws a readable error listing every problem. */
export function parseConfig(raw: unknown): JiraConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`,
    );
    throw new Error(`invalid jira connector config:\n  ${lines.join('\n  ')}`);
  }
  const c = result.data;
  const deployment =
    c.deployment ??
    (new URL(c.base_url).hostname.endsWith('.atlassian.net') ? 'cloud' : 'datacenter');
  return { ...c, deployment };
}

/** The `Authorization` header value. */
export function authorization(c: JiraConfig): string {
  if (c.token !== undefined) {
    return `Bearer ${c.token}`;
  }
  const user = c.email ?? c.username ?? '';
  const pass = c.api_token ?? c.password ?? '';
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** Every credential in the config, for scrubbing error messages. */
export function credentials(c: JiraConfig): string[] {
  return [c.api_token, c.token, c.password, authorization(c).split(' ')[1]].filter(
    (s): s is string => s !== undefined && s !== '',
  );
}
