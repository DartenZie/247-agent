import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSecretsBackend, SecretError, SecretsConfig, staticSecrets } from './secrets.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-sec-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('secrets backends', () => {
  it('env: reads OA_SECRET_<NAME> and fails on a missing one without echoing values', () => {
    const b = createSecretsBackend(SecretsConfig.parse({ backend: 'env' }), dir, {
      OA_SECRET_FTP_PASS: 'hunter2',
    });
    expect(b.resolve(['ftp_pass'])).toEqual({ ftp_pass: 'hunter2' });
    expect(b.resolve([])).toEqual({});
    expect(() => b.resolve(['ftp_pass', 'other'])).toThrow(SecretError);
    expect(() => b.resolve(['other'])).toThrow(/"other" is not set \(OA_SECRET_OTHER\)/);
    expect(() => b.resolve(['bad-name'])).toThrow(/invalid secret name/);
  });

  it('file: reads a YAML mapping relative to the config dir on every call', () => {
    writeFileSync(join(dir, 'secrets.yaml'), 'ftp_pass: one\nn: 5\n', { mode: 0o600 });
    const b = createSecretsBackend(
      SecretsConfig.parse({ backend: 'file', path: 'secrets.yaml' }),
      dir,
    );
    expect(b.resolve(['ftp_pass'])).toEqual({ ftp_pass: 'one' });
    writeFileSync(join(dir, 'secrets.yaml'), 'ftp_pass: two\n');
    expect(b.resolve(['ftp_pass'])).toEqual({ ftp_pass: 'two' });
    expect(() => b.resolve(['n'])).toThrow(/not a string/);
    expect(() => b.resolve(['missing'])).toThrow(/"missing" is not a string/);
    const gone = createSecretsBackend(
      SecretsConfig.parse({ backend: 'file', path: 'nope.yaml' }),
      dir,
    );
    expect(() => gone.resolve(['x'])).toThrow(/cannot read secrets file/);
  });

  it.skipIf(process.platform === 'win32')('file: refuses a file readable by others', () => {
    writeFileSync(join(dir, 'secrets.yaml'), 'ftp_pass: one\n');
    const b = createSecretsBackend(
      SecretsConfig.parse({ backend: 'file', path: 'secrets.yaml' }),
      dir,
    );
    chmodSync(join(dir, 'secrets.yaml'), 0o640);
    expect(() => b.resolve(['ftp_pass'])).toThrow(/mode must be 0600/);
    expect(() => b.resolve(['ftp_pass'])).not.toThrow(/one/);
    chmodSync(join(dir, 'secrets.yaml'), 0o600);
    expect(b.resolve(['ftp_pass'])).toEqual({ ftp_pass: 'one' });
  });

  it('systemd-credentials: one file per secret, trailing newline stripped', () => {
    writeFileSync(join(dir, 'imap_pass'), 'p@ss\n');
    const b = createSecretsBackend(SecretsConfig.parse({ backend: 'systemd-credentials' }), dir, {
      CREDENTIALS_DIRECTORY: dir,
    });
    expect(b.resolve(['imap_pass'])).toEqual({ imap_pass: 'p@ss' });
    expect(() => b.resolve(['nope'])).toThrow(/"nope" is not available/);
    const unset = createSecretsBackend(
      SecretsConfig.parse({ backend: 'systemd-credentials' }),
      dir,
      {},
    );
    expect(() => unset.resolve(['imap_pass'])).toThrow(/CREDENTIALS_DIRECTORY/);
    const explicit = createSecretsBackend(
      SecretsConfig.parse({ backend: 'systemd-credentials', dir: '.' }),
      dir,
      {},
    );
    expect(explicit.resolve(['imap_pass'])).toEqual({ imap_pass: 'p@ss' });
  });

  it('staticSecrets serves tests', () => {
    expect(staticSecrets({ a: '1' }).resolve(['a'])).toEqual({ a: '1' });
    expect(() => staticSecrets({}).resolve(['a'])).toThrow(SecretError);
  });
});
