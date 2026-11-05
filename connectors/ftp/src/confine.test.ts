import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileOps } from './ops.js';
import { ftpConfig, MemoryFileClient, removeTempDirs, tempDir } from './test-helpers.js';
import { FtpOpError } from './types.js';

afterEach(removeTempDirs);

/**
 * A memory client that also resolves paths the way a server does: relative paths from the
 * login directory, symlinks by prefix. `real` lists paths that exist only behind a link.
 */
class LinkedClient extends MemoryFileClient {
  constructor(
    seed: Record<string, string>,
    root: string,
    private readonly links: Record<string, string>,
    private readonly real: string[] = [],
  ) {
    super(seed, root);
  }

  realpath(path: string): Promise<string | null> {
    this.calls.push(`realpath ${path}`);
    let abs = path.startsWith('/') ? path : posix.join('/home/u', path);
    for (const [from, to] of Object.entries(this.links)) {
      if (abs === from || abs.startsWith(`${from}/`)) {
        abs = to + abs.slice(from.length);
      }
    }
    const exists =
      this.files.has(path) || this.dirs.has(path) || this.real.includes(abs) || abs === '/';
    return Promise.resolve(exists ? abs : null);
  }
}

function setup(links: Record<string, string>, real: string[] = [], root = '/srv/x') {
  const client = new LinkedClient(
    { [`${root}/notes.txt`]: 'hello', [`${root}/site/index.html`]: '<p>' },
    root,
    links,
    real,
  );
  const ops = new FileOps(
    ftpConfig({ root, local_roots: [tmpdir()] }),
    () => undefined,
    () => Promise.resolve(client),
  );
  return { ops, client };
}

const refusal = async (p: Promise<unknown>): Promise<FtpOpError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof FtpOpError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected the op to be refused');
};

const OUT = { '/srv/x/out': '/etc' };
const OUT_REAL = ['/etc', '/etc/passwd'];

describe('symlinks on the server', () => {
  it('refuses to read a file whose path resolves outside the root', async () => {
    const { ops, client } = setup(OUT, OUT_REAL);
    const err = await refusal(ops.read({ path: 'out/passwd' }));
    expect(err.code).toBe('path');
    expect(err.message).toMatch(/out\/passwd.*\/etc\/passwd.*outside the root.*symlink/);
    expect(client.calls.some((c) => c.startsWith('read') || c.startsWith('stat'))).toBe(false);
  });

  it('refuses every other op on a path through the link, the link itself included', async () => {
    const { ops, client } = setup(OUT, OUT_REAL);
    for (const op of [
      () => ops.list({ path: 'out' }),
      () => ops.stat({ path: 'out/passwd' }),
      () => ops.write({ path: 'out/new.txt', content: 'x' }),
      () => ops.mkdir({ path: 'out/a/b' }),
      () => ops.delete({ path: 'out', recursive: true }),
      () => ops.rename({ from: 'notes.txt', to: 'out/notes.txt' }),
      () => ops.delete({ path: 'out' }),
    ]) {
      expect((await refusal(op())).code).toBe('path');
    }
    expect(client.files.get('/srv/x/notes.txt')?.toString()).toBe('hello');
  });

  it('refuses a sync into a remote directory that links outside', async () => {
    const local = tempDir('confine-');
    writeFileSync(join(local, 'a.txt'), 'a');
    const { ops, client } = setup(OUT, OUT_REAL);
    expect((await refusal(ops.sync({ local, remote: 'out' }))).code).toBe('path');
    expect(client.calls.some((c) => c.startsWith('upload'))).toBe(false);
  });

  it('lets sync prune and rename move a link that points outside, never its target', async () => {
    const local = tempDir('confine-');
    writeFileSync(join(local, 'notes.txt'), 'new');
    const { ops, client } = setup({ ...OUT, '/srv/x/stats': '/usr/share/stats' }, [
      ...OUT_REAL,
      '/usr/share/stats',
    ]);
    client.seed('/srv/x/out', 'link');
    client.seed('/srv/x/stats', 'link');
    await ops.rename({ from: 'out', to: 'old-link' });
    expect(client.calls).toContain('rename /srv/x/out /srv/x/old-link');
    const r = await ops.sync({ local, prune: true });
    expect(r.pruned).toEqual(['old-link', 'site/index.html', 'stats', 'site']);
    expect(client.calls).toContain('remove /srv/x/stats');
    expect(client.calls.some((c) => c.includes('/usr/share') && !c.startsWith('realpath'))).toBe(
      false,
    );
  });

  it('allows paths that resolve inside the root, also when the root itself is a link', async () => {
    const { ops } = setup({ '/srv/x': '/data/x' }, [
      '/data/x',
      '/data/x/notes.txt',
      '/data/x/site',
    ]);
    expect((await ops.read({ path: 'notes.txt' })).content).toBe('hello');
    expect(await ops.write({ path: 'site/new.html', content: 'n' })).toMatchObject({ size: 1 });
    expect(await ops.mkdir({ path: 'fresh/deep' })).toEqual({ path: 'fresh/deep' });
  });

  it('allows a link that points to another place inside the root', async () => {
    const { ops, client } = setup({ '/srv/x/www': '/srv/x/site' }, [
      '/srv/x',
      '/srv/x/site/index.html',
    ]);
    client.seed('/srv/x/www/index.html', '<p>');
    expect((await ops.read({ path: 'www/index.html' })).content).toBe('<p>');
  });

  it('checks a relative root against the login directory', async () => {
    const { ops } = setup({ '/home/u/up/out': '/etc' }, ['/home/u/up', ...OUT_REAL], 'up');
    expect((await ops.read({ path: 'notes.txt' })).content).toBe('hello');
    expect((await refusal(ops.read({ path: 'out/passwd' }))).code).toBe('path');
  });
});
