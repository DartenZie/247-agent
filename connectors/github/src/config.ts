/**
 * The connector's config, as the core passes it in `OA_CONFIG_JSON` (secrets already
 * rendered). One token and the repositories the ops may touch; the first is the default
 * when an op names none.
 */
import { z } from 'zod';

const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const schema = z.strictObject({
  /** A fine-grained personal access token or an app installation token (`${secrets.<name>}`). */
  token: z.string().trim().min(1, 'the token is empty (is the secret set in the backend?)'),
  /** `owner/name` of every repository ops may touch; the first is the default. */
  repos: z
    .array(z.string().trim().regex(FULL_NAME, 'a repository is "owner/name"'))
    .min(1, 'name at least one repository')
    .transform((r) => [...new Set(r.map((n) => n.toLowerCase()))]),
  /** REST API base; `https://<host>/api/v3` for GitHub Enterprise Server. */
  api_base: z
    .url()
    .default('https://api.github.com')
    .transform((v) => v.replace(/\/+$/, '')),
  /** Timeout per API call in milliseconds. */
  timeout: z.number().int().min(1).default(30_000),
  /** Upper bound of the text a diff or a body returns, in characters. */
  max_text: z.number().int().min(1).default(200_000),
});

export type GitHubConfig = z.infer<typeof schema>;

/** Parses the raw config object; throws a readable error listing every problem. */
export function parseConfig(raw: unknown): GitHubConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`,
    );
    throw new Error(`invalid github connector config:\n  ${lines.join('\n  ')}`);
  }
  return result.data;
}
