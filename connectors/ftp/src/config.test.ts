import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';

describe('parseConfig', () => {
  it('fills defaults for sftp', () => {
    const c = parseConfig({ host: 'h', user: 'u', password: 'p' });
    expect(c).toMatchObject({
      protocol: 'sftp',
      port: 22,
      root: '.',
      max_bytes: 1_000_000,
      list_limit: 1000,
      timeout: 30_000,
      reject_unauthorized: true,
      tls: 'explicit',
    });
  });

  it('picks the port from protocol and tls mode, an explicit port wins', () => {
    expect(parseConfig({ protocol: 'ftp', host: 'h' }).port).toBe(21);
    expect(parseConfig({ protocol: 'ftps', host: 'h' }).port).toBe(21);
    expect(parseConfig({ protocol: 'ftps', host: 'h', tls: 'implicit' }).port).toBe(990);
    expect(parseConfig({ protocol: 'ftps', host: 'h', tls: 'implicit', port: 2990 }).port).toBe(
      2990,
    );
    expect(parseConfig({ host: 'h', user: 'u', private_key: 'PEM', port: 2222 }).port).toBe(2222);
  });

  it('normalises the root', () => {
    expect(parseConfig({ protocol: 'ftp', host: 'h', root: '/srv/x/' }).root).toBe('/srv/x');
    expect(parseConfig({ protocol: 'ftp', host: 'h', root: '/' }).root).toBe('/');
  });

  it('requires credentials for sftp and allows anonymous ftp', () => {
    expect(() => parseConfig({ host: 'h' })).toThrow(/user: required for sftp/);
    expect(() => parseConfig({ host: 'h', user: 'u' })).toThrow(/"password" or "private_key"/);
    expect(
      parseConfig({ host: 'h', user: 'u', private_key: 'PEM', passphrase: 'x' }),
    ).toMatchObject({ private_key: 'PEM' });
    expect(parseConfig({ protocol: 'ftp', host: 'h' }).user).toBeUndefined();
  });

  it('rejects protocol-specific keys on the wrong protocol', () => {
    expect(() => parseConfig({ protocol: 'ftp', host: 'h', private_key: 'PEM' })).toThrow(
      /private_key: only valid with protocol sftp/,
    );
    expect(() =>
      parseConfig({ protocol: 'ftps', host: 'h', host_key_fingerprint: 'SHA256:x' }),
    ).toThrow(/host_key_fingerprint: only valid/);
    expect(() => parseConfig({ protocol: 'ftp', host: 'h', tls: 'implicit' })).toThrow(
      /tls: only valid with protocol ftps/,
    );
    expect(() => parseConfig({ host: 'h', user: 'u', password: 'p', tls: 'explicit' })).toThrow(
      /tls: only valid/,
    );
  });

  it('reports every problem with its path', () => {
    let message = '';
    try {
      parseConfig({ protocol: 'nntp', port: 0, max_bytes: 0 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^invalid ftp connector config:/);
    for (const path of ['protocol', 'port', 'host', 'max_bytes']) {
      expect(message).toContain(`\n  ${path}: `);
    }
  });
});
