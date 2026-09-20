import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  connectSftp,
  hostKeyMatches,
  type SftpConnectOptions,
  type SftpFileInfo,
  type SftpFileStats,
  type SftpLib,
} from './sftp.js';
import { ftpConfig } from './test-helpers.js';

interface FakeSftp {
  lib: SftpLib;
  calls: string[];
  connect: SftpConnectOptions | null;
  puts: { path: string; data: Buffer }[];
}

const notFound = (): Error => Object.assign(new Error('stat: No such file /x'), { code: 'ENOENT' });

function fakeSftp(files: Record<string, string> = {}, dirs: string[] = []): FakeSftp {
  const fake: FakeSftp = { calls: [], connect: null, puts: [], lib: undefined as never };
  const store = new Map(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)]));
  const stat = (path: string): SftpFileStats => {
    const f = store.get(path);
    if (f !== undefined) {
      return {
        size: f.length,
        modifyTime: 1_700_000_000_000,
        isDirectory: false,
        isSymbolicLink: false,
      };
    }
    if (dirs.includes(path)) {
      return { size: 0, modifyTime: 1_700_000_000_000, isDirectory: true, isSymbolicLink: false };
    }
    if (path === '/denied') {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    throw notFound();
  };
  fake.lib = {
    connect: (o) => {
      fake.calls.push('connect');
      fake.connect = o;
      return Promise.resolve();
    },
    list: (path) => {
      fake.calls.push(`list ${path}`);
      const infos: SftpFileInfo[] = [
        { type: '-', name: 'f.txt', size: 3, modifyTime: 1_700_000_000_000 },
        { type: 'd', name: 'sub', size: 4096, modifyTime: 1_700_000_000_000 },
        { type: 'l', name: 'link', size: 1, modifyTime: 1_700_000_000_000 },
      ];
      return Promise.resolve(infos);
    },
    stat: (path) => {
      fake.calls.push(`stat ${path}`);
      // A throw inside the executor rejects the promise.
      return new Promise((resolve) => {
        resolve(stat(path));
      });
    },
    get: (path) => {
      fake.calls.push(`get ${path}`);
      const f = store.get(path);
      return f === undefined ? Promise.reject(notFound()) : Promise.resolve(f);
    },
    put: (data, path) => {
      fake.calls.push(`put ${path}`);
      fake.puts.push({ path, data });
      return Promise.resolve('ok');
    },
    delete: (path) => {
      fake.calls.push(`delete ${path}`);
      return Promise.resolve('ok');
    },
    rmdir: (path, recursive) => {
      fake.calls.push(`rmdir ${path} ${String(recursive ?? false)}`);
      return Promise.resolve('ok');
    },
    rename: (from, to) => {
      fake.calls.push(`rename ${from} ${to}`);
      return Promise.resolve('ok');
    },
    mkdir: (path, recursive) => {
      fake.calls.push(`mkdir ${path} ${String(recursive ?? false)}`);
      return Promise.resolve('ok');
    },
    end: () => {
      fake.calls.push('end');
      return Promise.resolve(true);
    },
  };
  return fake;
}

describe('connectSftp', () => {
  it('maps password credentials and the timeout', async () => {
    const fake = fakeSftp();
    const client = await connectSftp(ftpConfig({ port: 2222, timeout: 5000 }), () => fake.lib);
    expect(fake.connect).toEqual({
      host: 'h',
      port: 2222,
      username: 'u',
      password: 'p',
      readyTimeout: 5000,
    });
    await client.close();
    expect(fake.calls).toEqual(['connect', 'end']);
  });

  it('maps a private key with passphrase and installs a host verifier', async () => {
    const fake = fakeSftp();
    const key = Buffer.from('host-key');
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
    await connectSftp(
      ftpConfig({
        password: undefined,
        private_key: 'PEM',
        passphrase: 'pp',
        host_key_fingerprint: fingerprint,
      }),
      () => fake.lib,
    );
    expect(fake.connect).toMatchObject({ privateKey: 'PEM', passphrase: 'pp' });
    expect(fake.connect).not.toHaveProperty('password');
    const verifier = fake.connect?.hostVerifier;
    expect(verifier?.(key)).toBe(true);
    expect(verifier?.(Buffer.from('other'))).toBe(false);
  });

  it('wraps a connection failure with the endpoint', async () => {
    const fake = fakeSftp();
    fake.lib.connect = () =>
      Promise.reject(new Error('All configured authentication methods failed'));
    await expect(connectSftp(ftpConfig(), () => fake.lib)).rejects.toThrow(
      /^sftp connect h:22: All configured/,
    );
  });
});

describe('hostKeyMatches', () => {
  const key = Buffer.from('k');
  const digest = createHash('sha256').update(key).digest();

  it('accepts OpenSSH base64 (with or without padding) and hex forms', () => {
    const b64 = digest.toString('base64');
    expect(hostKeyMatches(key, `SHA256:${b64}`)).toBe(true);
    expect(hostKeyMatches(key, `sha256:${b64.replace(/=+$/, '')}`)).toBe(true);
    expect(hostKeyMatches(key, digest.toString('hex'))).toBe(true);
    expect(hostKeyMatches(key, digest.toString('hex').toUpperCase())).toBe(true);
    expect(hostKeyMatches(key, 'SHA256:nope')).toBe(false);
  });
});

describe('SftpFileClient', () => {
  it('maps list types and times', async () => {
    const fake = fakeSftp();
    const client = await connectSftp(ftpConfig(), () => fake.lib);
    const entries = await client.list('/srv');
    expect(entries.map((e) => [e.name, e.type, e.size])).toEqual([
      ['f.txt', 'file', 3],
      ['sub', 'dir', 4096],
      ['link', 'symlink', 1],
    ]);
    expect(entries[0]?.mtime?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('turns ENOENT into null on stat but rethrows other errors', async () => {
    const fake = fakeSftp({ '/srv/f.txt': 'abc' }, ['/srv/d']);
    const client = await connectSftp(ftpConfig(), () => fake.lib);
    expect(await client.stat('/srv/f.txt')).toMatchObject({ name: 'f.txt', type: 'file', size: 3 });
    expect(await client.stat('/srv/d')).toMatchObject({ name: 'd', type: 'dir' });
    expect(await client.stat('/srv/nope')).toBeNull();
    await expect(client.stat('/denied')).rejects.toThrow(/^sftp stat \/denied: permission denied/);
  });

  it('reads a Buffer, writes a Buffer, and forwards the rest', async () => {
    const fake = fakeSftp({ '/srv/f.txt': 'abc' });
    const client = await connectSftp(ftpConfig(), () => fake.lib);
    expect((await client.read('/srv/f.txt')).toString()).toBe('abc');
    await expect(client.read('/srv/nope')).rejects.toThrow(/^sftp get \/srv\/nope: /);
    await client.write('/srv/new.txt', Buffer.from('new'));
    expect(fake.puts).toEqual([{ path: '/srv/new.txt', data: Buffer.from('new') }]);
    await client.remove('/srv/f.txt');
    await client.rmdir('/srv/d', true);
    await client.rename('/srv/a', '/srv/b');
    await client.mkdir('/srv/x/y');
    expect(fake.calls.slice(-4)).toEqual([
      'delete /srv/f.txt',
      'rmdir /srv/d true',
      'rename /srv/a /srv/b',
      'mkdir /srv/x/y true',
    ]);
  });

  it('rejects a non-Buffer result from get', async () => {
    const fake = fakeSftp();
    fake.lib.get = () => Promise.resolve('/tmp/wrote-a-file');
    const client = await connectSftp(ftpConfig(), () => fake.lib);
    await expect(client.read('/srv/f')).rejects.toThrow(/expected a Buffer/);
  });
});
