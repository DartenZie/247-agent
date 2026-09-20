import { describe, expect, it } from 'vitest';

import { FileOps } from './ops.js';
import { ftpConfig, MemoryFileClient } from './test-helpers.js';
import { FtpOpError } from './types.js';

const SEED = {
  'incoming/b.csv': 'b;2',
  'incoming/a.csv': 'a;1',
  'incoming/sub/deep.txt': 'deep',
  'notes.txt': 'hello',
};

function setup(extra: Record<string, unknown> = {}, root = '/srv/x') {
  const config = ftpConfig({ root, ...extra });
  const seeded: Record<string, string> = {};
  for (const [p, c] of Object.entries(SEED)) {
    seeded[root === '.' ? p : `${root}/${p}`] = c;
  }
  const client = new MemoryFileClient(seeded, root);
  const log: string[] = [];
  let connects = 0;
  const ops = new FileOps(
    config,
    (l) => log.push(l),
    () => {
      connects += 1;
      client.closed = false;
      return Promise.resolve(client);
    },
  );
  return { ops, client, log, connects: () => connects };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof FtpOpError ? err.code : `other: ${(err as Error).message}`;
  }
};

describe('list', () => {
  it('sorts by name and reports relative paths', async () => {
    const { ops, client } = setup();
    const r = await ops.list({ path: 'incoming' });
    expect(r).toMatchObject({ path: 'incoming', truncated: false });
    expect(r.entries.map((e) => [e.name, e.path, e.type, e.size])).toEqual([
      ['a.csv', 'incoming/a.csv', 'file', 3],
      ['b.csv', 'incoming/b.csv', 'file', 3],
      ['sub', 'incoming/sub', 'dir', 0],
    ]);
    expect(r.entries[0]?.mtime).toBe('2026-06-01T08:00:00.000Z');
    expect(r.entries[2]?.mtime).toBeNull();
    expect(client.calls).toEqual(['list /srv/x/incoming', 'close']);
  });

  it('defaults to the root and applies limit and list_limit', async () => {
    const { ops } = setup({ list_limit: 2 });
    const root = await ops.list({});
    expect(root.path).toBe('.');
    expect(root.entries.map((e) => e.path)).toEqual(['incoming', 'notes.txt']);
    const limited = await ops.list({ path: 'incoming', limit: 1 });
    expect(limited.entries).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    const capped = await ops.list({ path: 'incoming', limit: 50 });
    expect(capped.entries).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('works with a relative root', async () => {
    const { ops, client } = setup({}, '.');
    const r = await ops.list({});
    expect(r.entries.map((e) => e.path)).toEqual(['incoming', 'notes.txt']);
    expect(client.calls[0]).toBe('list .');
  });
});

describe('stat', () => {
  it('reports files, directories and missing paths', async () => {
    const { ops } = setup();
    expect(await ops.stat({ path: 'notes.txt' })).toMatchObject({
      exists: true,
      path: 'notes.txt',
      type: 'file',
      size: 5,
    });
    expect(await ops.stat({ path: 'incoming/sub' })).toMatchObject({ exists: true, type: 'dir' });
    expect(await ops.stat({ path: '.' })).toMatchObject({ exists: true, type: 'dir', path: '.' });
    expect(await ops.stat({ path: 'nope' })).toEqual({ exists: false, path: 'nope' });
  });
});

describe('read', () => {
  it('returns utf8 by default and base64 on request', async () => {
    const { ops, client } = setup();
    expect(await ops.read({ path: 'notes.txt' })).toEqual({
      path: 'notes.txt',
      content: 'hello',
      encoding: 'utf8',
      size: 5,
    });
    expect(await ops.read({ path: 'notes.txt', encoding: 'base64' })).toMatchObject({
      content: Buffer.from('hello').toString('base64'),
      encoding: 'base64',
    });
    expect(client.calls).toEqual([
      'stat /srv/x/notes.txt',
      'read /srv/x/notes.txt',
      'close',
      'stat /srv/x/notes.txt',
      'read /srv/x/notes.txt',
      'close',
    ]);
  });

  it('fails on a missing path, a directory, and a file over max_bytes', async () => {
    const { ops, client } = setup({ max_bytes: 4 });
    expect(await code(ops.read({ path: 'nope' }))).toBe('not_found');
    expect(await code(ops.read({ path: 'incoming' }))).toBe('path');
    expect(await code(ops.read({ path: 'notes.txt' }))).toBe('too_large');
    expect(client.calls.filter((c) => c.startsWith('read'))).toEqual([]);
    expect(await ops.read({ path: 'incoming/a.csv' })).toMatchObject({ content: 'a;1' });
  });

  it('checks the size again after the transfer when the listing lied', async () => {
    const { ops, client } = setup({ max_bytes: 4 });
    const realStat = client.stat.bind(client);
    client.stat = async (p) => {
      const s = await realStat(p);
      return s === null ? null : { ...s, size: 0 };
    };
    expect(await code(ops.read({ path: 'notes.txt' }))).toBe('too_large');
  });
});

describe('write', () => {
  it('creates, overwrites and reports the size', async () => {
    const { ops, client } = setup();
    expect(await ops.write({ path: 'out/report.txt', content: 'one' })).toEqual({
      path: 'out/report.txt',
      size: 3,
    });
    expect(client.files.get('/srv/x/out/report.txt')?.toString()).toBe('one');
    expect(client.calls).toEqual(['mkdir /srv/x/out', 'write /srv/x/out/report.txt', 'close']);
    await ops.write({ path: 'out/report.txt', content: 'two' });
    expect(client.files.get('/srv/x/out/report.txt')?.toString()).toBe('two');
  });

  it('skips mkdir for a top-level file and when parents is false', async () => {
    const { ops, client } = setup();
    await ops.write({ path: 'top.txt', content: 'x' });
    expect(client.calls).toEqual(['write /srv/x/top.txt', 'close']);
    client.calls.length = 0;
    expect(await code(ops.write({ path: 'new/x.txt', content: 'x', parents: false }))).toMatch(
      /^other: no such directory/,
    );
    expect(client.calls).toEqual(['write /srv/x/new/x.txt', 'close']);
  });

  it('respects overwrite: false and max_bytes, and round-trips base64', async () => {
    const { ops, client } = setup({ max_bytes: 4 });
    expect(await code(ops.write({ path: 'notes.txt', content: 'x', overwrite: false }))).toBe(
      'exists',
    );
    expect(await code(ops.write({ path: 'big.txt', content: 'hello' }))).toBe('too_large');
    expect(client.calls).toEqual(['stat /srv/x/notes.txt', 'close']);
    const bytes = Buffer.from([0, 255, 1, 2]);
    await ops.write({ path: 'bin', content: bytes.toString('base64'), encoding: 'base64' });
    expect(client.files.get('/srv/x/bin')).toEqual(bytes);
    expect(await ops.read({ path: 'bin', encoding: 'base64' })).toMatchObject({
      content: bytes.toString('base64'),
    });
  });
});

describe('delete', () => {
  it('removes files and directories', async () => {
    const { ops, client } = setup();
    expect(await ops.delete({ path: 'notes.txt' })).toEqual({
      path: 'notes.txt',
      deleted: true,
      type: 'file',
    });
    expect(client.files.has('/srv/x/notes.txt')).toBe(false);
    expect(await code(ops.delete({ path: 'incoming' }))).toMatch(/^other: directory not empty/);
    expect(await ops.delete({ path: 'incoming', recursive: true })).toMatchObject({
      deleted: true,
      type: 'dir',
    });
    expect([...client.files.keys()]).toEqual([]);
  });

  it('handles a missing path and refuses the root', async () => {
    const { ops, client } = setup();
    expect(await code(ops.delete({ path: 'nope' }))).toBe('not_found');
    expect(await ops.delete({ path: 'nope', missing_ok: true })).toEqual({
      path: 'nope',
      deleted: false,
      type: null,
    });
    client.calls.length = 0;
    expect(await code(ops.delete({ path: '.', recursive: true }))).toBe('path');
    expect(client.calls).toEqual([]);
  });
});

describe('rename', () => {
  it('moves a file, creating the target directory on request', async () => {
    const { ops, client } = setup();
    expect(
      await ops.rename({ from: 'incoming/a.csv', to: 'processed/a.csv', parents: true }),
    ).toEqual({ from: 'incoming/a.csv', to: 'processed/a.csv' });
    expect(client.calls).toEqual([
      'mkdir /srv/x/processed',
      'rename /srv/x/incoming/a.csv /srv/x/processed/a.csv',
      'close',
    ]);
    expect(client.files.has('/srv/x/processed/a.csv')).toBe(true);
    client.calls.length = 0;
    await ops.rename({ from: 'incoming/b.csv', to: 'b.csv' });
    expect(client.calls).toEqual(['rename /srv/x/incoming/b.csv /srv/x/b.csv', 'close']);
    expect(await code(ops.rename({ from: '.', to: 'x' }))).toBe('path');
  });
});

describe('mkdir', () => {
  it('creates nested directories', async () => {
    const { ops, client } = setup();
    expect(await ops.mkdir({ path: 'a/b/c' })).toEqual({ path: 'a/b/c' });
    expect(client.dirs.has('/srv/x/a/b/c')).toBe(true);
    expect(client.dirs.has('/srv/x/a')).toBe(true);
  });
});

describe('every op', () => {
  it('rejects escaping paths before connecting', async () => {
    const { ops, client, connects } = setup();
    const attempts = [
      ops.list({ path: '../x' }),
      ops.stat({ path: '/etc/passwd' }),
      ops.read({ path: '..' }),
      ops.write({ path: '../x', content: '' }),
      ops.delete({ path: 'a/../../x' }),
      ops.rename({ from: 'a', to: '../b' }),
      ops.rename({ from: '../a', to: 'b' }),
      ops.mkdir({ path: '/abs' }),
    ];
    for (const a of attempts) {
      expect(await code(a)).toBe('path');
    }
    expect(connects()).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it('opens one connection per call and closes it even on failure', async () => {
    const { ops, client, connects } = setup();
    await ops.stat({ path: 'x' });
    await ops.stat({ path: 'y' });
    expect(connects()).toBe(2);
    client.calls.length = 0;
    expect(await code(ops.read({ path: 'nope' }))).toBe('not_found');
    expect(client.calls).toEqual(['stat /srv/x/nope', 'close']);
    expect(client.closed).toBe(true);
  });
});
