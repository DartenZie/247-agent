import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Secrets (ARCHITECTURE §7, §11) are referenced by name (`${secrets.ftp_pass}`) and
 * resolved from one backend at run time, only for the runs whose templates name them. A
 * resolved value lives in the action context and in a connector's environment; it never
 * reaches the store, the log or an event payload.
 */
export const SecretsConfig = z.discriminatedUnion('backend', [
  /** `OA_SECRET_<NAME>` (upper-cased) in the daemon's environment. */
  z.strictObject({ backend: z.literal('env'), prefix: z.string().default('OA_SECRET_') }),
  /** A YAML/JSON file mapping name → string, re-read on every resolve. */
  z.strictObject({ backend: z.literal('file'), path: z.string().min(1) }),
  /** One file per secret under `$CREDENTIALS_DIRECTORY` (systemd `LoadCredential=`). */
  z.strictObject({ backend: z.literal('systemd-credentials'), dir: z.string().min(1).optional() }),
]);

export type SecretsConfigInput = z.input<typeof SecretsConfig>;
export type SecretsConfigParsed = z.infer<typeof SecretsConfig>;

const NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export class SecretError extends Error {
  constructor(
    readonly secret: string,
    message: string,
  ) {
    super(message);
    this.name = 'SecretError';
  }
}

export interface SecretsBackend {
  readonly kind: SecretsConfigParsed['backend'];
  /** Resolves every name or throws `SecretError` for the first one it cannot. */
  resolve(names: readonly string[]): Record<string, string>;
}

function check(name: string): void {
  if (!NAME.test(name)) {
    throw new SecretError(name, `invalid secret name "${name}"`);
  }
}

function envBackend(prefix: string, env: NodeJS.ProcessEnv): SecretsBackend {
  return {
    kind: 'env',
    resolve: (names) => {
      const out: Record<string, string> = {};
      for (const name of names) {
        check(name);
        const key = `${prefix}${name.toUpperCase()}`;
        const value = env[key];
        if (value === undefined) {
          throw new SecretError(name, `secret "${name}" is not set (${key})`);
        }
        out[name] = value;
      }
      return out;
    },
  };
}

/** Group or world can read the file: a secret would be one `cat` away for any local user. */
function isWideOpen(mode: number): boolean {
  return process.platform !== 'win32' && (mode & 0o077) !== 0;
}

function fileBackend(path: string): SecretsBackend {
  return {
    kind: 'file',
    resolve: (names) => {
      names.forEach(check);
      if (names.length === 0) {
        return {};
      }
      let doc: unknown;
      try {
        if (isWideOpen(statSync(path).mode)) {
          throw new Error('mode must be 0600 (readable by the service user only)');
        }
        doc = parseYaml(readFileSync(path, 'utf8'));
      } catch (err) {
        throw new SecretError(
          names[0] ?? '',
          `cannot read secrets file ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new SecretError(names[0] ?? '', `secrets file ${path} is not a mapping`);
      }
      const map = doc as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const name of names) {
        const value = map[name];
        if (typeof value !== 'string') {
          throw new SecretError(name, `secret "${name}" is not a string in ${path}`);
        }
        out[name] = value;
      }
      return out;
    },
  };
}

function systemdBackend(dir: string | undefined, env: NodeJS.ProcessEnv): SecretsBackend {
  return {
    kind: 'systemd-credentials',
    resolve: (names) => {
      const out: Record<string, string> = {};
      for (const name of names) {
        check(name);
        const base = dir ?? env.CREDENTIALS_DIRECTORY;
        if (base === undefined) {
          throw new SecretError(
            name,
            `secret "${name}": CREDENTIALS_DIRECTORY is not set (not started by systemd?)`,
          );
        }
        try {
          out[name] = readFileSync(join(base, name), 'utf8').replace(/\r?\n$/, '');
        } catch (err) {
          throw new SecretError(
            name,
            `secret "${name}" is not available: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return out;
    },
  };
}

/** Builds the configured backend. Relative `path`/`dir` resolve against `baseDir`. */
export function createSecretsBackend(
  config: SecretsConfigParsed,
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretsBackend {
  switch (config.backend) {
    case 'env':
      return envBackend(config.prefix, env);
    case 'file':
      return fileBackend(resolve(baseDir, config.path));
    case 'systemd-credentials':
      return systemdBackend(
        config.dir === undefined ? undefined : resolve(baseDir, config.dir),
        env,
      );
  }
}

/** A backend for tests and for tasks that use no secrets. */
export function staticSecrets(values: Record<string, string>): SecretsBackend {
  return {
    kind: 'env',
    resolve: (names) => {
      const out: Record<string, string> = {};
      for (const name of names) {
        const v = values[name];
        if (v === undefined) {
          throw new SecretError(name, `secret "${name}" is not set`);
        }
        out[name] = v;
      }
      return out;
    },
  };
}
