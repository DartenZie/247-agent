/**
 * The connector's config, as the core passes it in `OA_CONFIG_JSON` (secrets already
 * rendered). One remote endpoint and one `root` directory every op is confined to.
 */
import { z } from 'zod';

import { normalizeRoot } from './paths.js';

const port = z.number().int().min(1).max(65535);

const schema = z
  .object({
    protocol: z.enum(['sftp', 'ftp', 'ftps']).default('sftp'),
    host: z.string().min(1),
    /** Defaults from the protocol: sftp 22, ftp 21, ftps 21 (explicit) or 990 (implicit). */
    port: port.optional(),
    /** Required for sftp; ftp/ftps default to anonymous. */
    user: z.string().min(1).optional(),
    password: z.string().optional(),
    /** sftp only: the private key as PEM/OpenSSH text (`${secrets.<name>}`). */
    private_key: z.string().min(1).optional(),
    passphrase: z.string().optional(),
    /** sftp only: `SHA256:<base64>` (as `ssh-keygen -l` prints) or hex; connection refused on mismatch. */
    host_key_fingerprint: z.string().min(1).optional(),
    /** ftps only: `explicit` upgrades with AUTH TLS on port 21, `implicit` is TLS from the first byte. */
    tls: z.enum(['explicit', 'implicit']).optional(),
    /** ftps: verify the server certificate. Only switch off for a private test server. */
    reject_unauthorized: z.boolean().default(true),
    /** The remote directory every path is relative to and confined in. */
    root: z.string().min(1).default('.'),
    /** Upper bound in bytes for `read` results and `write` payloads. */
    max_bytes: z.number().int().min(1).default(1_000_000),
    /** Upper bound of entries one `list` returns. */
    list_limit: z.number().int().min(1).max(10_000).default(1000),
    /** Connect and command timeout in milliseconds. */
    timeout: z.number().int().min(1).default(30_000),
  })
  .superRefine((c, ctx) => {
    const sftpOnly = ['private_key', 'passphrase', 'host_key_fingerprint'] as const;
    if (c.protocol !== 'sftp') {
      for (const key of sftpOnly) {
        if (c[key] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'only valid with protocol sftp' });
        }
      }
    }
    if (c.protocol === 'sftp') {
      if (c.user === undefined) {
        ctx.addIssue({ code: 'custom', path: ['user'], message: 'required for sftp' });
      }
      if (c.password === undefined && c.private_key === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['password'],
          message: 'sftp needs "password" or "private_key"',
        });
      }
    }
    if (c.protocol !== 'ftps' && c.tls !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['tls'], message: 'only valid with protocol ftps' });
    }
  });

export type FtpConfig = Omit<z.infer<typeof schema>, 'port' | 'tls'> & {
  port: number;
  tls: 'explicit' | 'implicit';
};

/** Parses the raw config object; throws a readable error listing every problem. */
export function parseConfig(raw: unknown): FtpConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`,
    );
    throw new Error(`invalid ftp connector config:\n  ${lines.join('\n  ')}`);
  }
  const c = result.data;
  const tls = c.tls ?? 'explicit';
  return {
    ...c,
    tls,
    port: c.port ?? defaultPort(c.protocol, tls),
    root: normalizeRoot(c.root),
  };
}

function defaultPort(protocol: 'sftp' | 'ftp' | 'ftps', tls: 'explicit' | 'implicit'): number {
  if (protocol === 'sftp') {
    return 22;
  }
  return protocol === 'ftps' && tls === 'implicit' ? 990 : 21;
}
