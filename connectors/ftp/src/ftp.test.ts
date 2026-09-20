import type { Readable, Writable } from 'node:stream';

import { FileType } from 'basic-ftp';
import { describe, expect, it } from 'vitest';

import {
  accessOptions,
  connectFtp,
  type FtpAccessOptions,
  type FtpFileInfo,
  type FtpLib,
} from './ftp.js';
import { ftpConfig } from './test-helpers.js';

interface FakeFtp {
  lib: FtpLib;
  calls: string[];
  access: FtpAccessOptions | null;
  uploads: { path: string; data: Buffer }[];
  closed: boolean;
}

function fakeFtp(
  listing: Record<string, FtpFileInfo[]> = {},
  files: Record<string, string> = {},
): FakeFtp {
  const fake: FakeFtp = {
    calls: [],
    access: null,
    uploads: [],
    closed: false,
    lib: undefined as never,
  };
  let cwd = '/home/u';
  fake.lib = {
    access: (o) => {
      fake.calls.push('access');
      fake.access = o;
      return Promise.resolve();
    },
    list: (path) => {
      fake.calls.push(`list ${path}`);
      const l = listing[path];
      return l === undefined
        ? Promise.reject(new Error('550 No such directory'))
        : Promise.resolve(l);
    },
    downloadTo: async (dst: Writable, path) => {
      fake.calls.push(`download ${path}`);
      const content = files[path];
      if (content === undefined) {
        throw new Error('550 File not found');
      }
      // Two chunks, like a real data connection.
      for (const chunk of [content.slice(0, 2), content.slice(2)]) {
        await new Promise<void>((resolve, reject) => {
          dst.write(Buffer.from(chunk), (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }
      await new Promise<void>((resolve) => dst.end(resolve));
    },
    uploadFrom: async (src: Readable, path) => {
      fake.calls.push(`upload ${path}`);
      const chunks: Buffer[] = [];
      for await (const c of src) {
        chunks.push(Buffer.from(c as Buffer));
      }
      fake.uploads.push({ path, data: Buffer.concat(chunks) });
    },
    remove: (path) => {
      fake.calls.push(`remove ${path}`);
      return Promise.resolve();
    },
    removeDir: (path) => {
      fake.calls.push(`removeDir ${path}`);
      return Promise.resolve();
    },
    removeEmptyDir: (path) => {
      fake.calls.push(`removeEmptyDir ${path}`);
      return Promise.resolve();
    },
    rename: (from, to) => {
      fake.calls.push(`rename ${from} ${to}`);
      return Promise.resolve();
    },
    ensureDir: (path) => {
      fake.calls.push(`ensureDir ${path}`);
      cwd = path;
      return Promise.resolve();
    },
    pwd: () => {
      fake.calls.push('pwd');
      return Promise.resolve(cwd);
    },
    cd: (path) => {
      fake.calls.push(`cd ${path}`);
      cwd = path;
      return Promise.resolve();
    },
    close: () => {
      fake.calls.push('close');
      fake.closed = true;
    },
  };
  return fake;
}

const info = (name: string, type: FileType, size = 0, modifiedAt?: Date): FtpFileInfo => ({
  name,
  type,
  size,
  ...(modifiedAt === undefined ? {} : { modifiedAt }),
});

describe('accessOptions', () => {
  it('maps ftp, explicit and implicit ftps', () => {
    expect(accessOptions(ftpConfig({ protocol: 'ftp' }))).toEqual({
      host: 'h',
      port: 21,
      user: 'u',
      password: 'p',
      secure: false,
      secureOptions: { rejectUnauthorized: true },
    });
    expect(
      accessOptions(ftpConfig({ protocol: 'ftps', reject_unauthorized: false })),
    ).toMatchObject({
      port: 21,
      secure: true,
      secureOptions: { rejectUnauthorized: false },
    });
    expect(accessOptions(ftpConfig({ protocol: 'ftps', tls: 'implicit' }))).toMatchObject({
      port: 990,
      secure: 'implicit',
    });
    expect(
      accessOptions(ftpConfig({ protocol: 'ftp', user: undefined, password: undefined })),
    ).toMatchObject({ user: 'anonymous', password: 'guest' });
  });
});

describe('connectFtp', () => {
  it('passes the timeout to the factory and closes on failure', async () => {
    const fake = fakeFtp();
    let timeout = 0;
    const client = await connectFtp(ftpConfig({ protocol: 'ftp', timeout: 7000 }), (t) => {
      timeout = t;
      return fake.lib;
    });
    expect(timeout).toBe(7000);
    expect(fake.access?.host).toBe('h');
    await client.close();
    expect(fake.closed).toBe(true);

    const failing = fakeFtp();
    failing.lib.access = () => Promise.reject(new Error('530 Login incorrect'));
    await expect(connectFtp(ftpConfig({ protocol: 'ftp' }), () => failing.lib)).rejects.toThrow(
      /^ftp connect h:21: 530/,
    );
    expect(failing.closed).toBe(true);
  });
});

describe('FtpFileClient', () => {
  const when = new Date('2026-01-02T03:04:05.000Z');
  const listing = {
    '/srv': [
      info('f.txt', FileType.File, 3, when),
      info('sub', FileType.Directory),
      info('link', FileType.SymbolicLink, 1),
      info('.', FileType.Directory),
      info('..', FileType.Directory),
    ],
    '/srv/sub': [info('old.txt', FileType.File, 2)],
  };

  it('maps list entries and leaves mtime null without MLSD', async () => {
    const fake = fakeFtp(listing);
    const client = await connectFtp(ftpConfig({ protocol: 'ftp', root: '/srv' }), () => fake.lib);
    const entries = await client.list('/srv');
    expect(entries.map((e) => [e.name, e.type, e.size, e.mtime])).toEqual([
      ['f.txt', 'file', 3, when],
      ['sub', 'dir', 0, null],
      ['link', 'symlink', 1, null],
    ]);
    await expect(client.list('/nope')).rejects.toThrow(/^ftp list \/nope: 550/);
  });

  it('stats through the parent listing and knows the root', async () => {
    const fake = fakeFtp(listing);
    const client = await connectFtp(ftpConfig({ protocol: 'ftp', root: '/srv' }), () => fake.lib);
    expect(await client.stat('/srv/f.txt')).toMatchObject({ name: 'f.txt', type: 'file', size: 3 });
    expect(await client.stat('/srv/sub/old.txt')).toMatchObject({ type: 'file', size: 2 });
    expect(await client.stat('/srv/nope')).toBeNull();
    expect(await client.stat('/srv')).toMatchObject({ type: 'dir' });
    expect(fake.calls.filter((c) => c.startsWith('list'))).toEqual([
      'list /srv',
      'list /srv/sub',
      'list /srv',
    ]);
  });

  it('downloads into a buffer and uploads from one', async () => {
    const fake = fakeFtp(listing, { '/srv/f.txt': 'hello world' });
    const client = await connectFtp(ftpConfig({ protocol: 'ftp', root: '/srv' }), () => fake.lib);
    expect((await client.read('/srv/f.txt')).toString()).toBe('hello world');
    await expect(client.read('/srv/nope')).rejects.toThrow(/^ftp download \/srv\/nope: 550/);
    const bytes = Buffer.from([0, 1, 255, 7]);
    await client.write('/srv/bin', bytes);
    expect(fake.uploads).toEqual([{ path: '/srv/bin', data: bytes }]);
  });

  it('restores the working directory after mkdir and forwards the rest', async () => {
    const fake = fakeFtp(listing);
    const client = await connectFtp(ftpConfig({ protocol: 'ftp', root: '/srv' }), () => fake.lib);
    fake.calls.length = 0;
    await client.mkdir('/srv/a/b');
    expect(fake.calls).toEqual(['pwd', 'ensureDir /srv/a/b', 'cd /home/u']);
    fake.calls.length = 0;
    await client.remove('/srv/f.txt');
    await client.rmdir('/srv/sub', false);
    await client.rmdir('/srv/sub', true);
    await client.rename('/srv/a', '/srv/b');
    expect(fake.calls).toEqual([
      'remove /srv/f.txt',
      'removeEmptyDir /srv/sub',
      'removeDir /srv/sub',
      'rename /srv/a /srv/b',
    ]);
  });
});
