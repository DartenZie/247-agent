/**
 * Server-side confinement. `paths.ts` keeps the text of a path inside the root; this module
 * keeps what the path *means on the server* inside it. A symlink under the root can point
 * anywhere, so before each call the wrapper asks the server where the path really leads and
 * refuses it when that is outside the root's own real location.
 *
 * Only clients that can resolve a path (`realpath`, i.e. SFTP) are wrapped; FTP has no
 * such command and relies on the account's chroot.
 */
import { posix } from 'node:path';

import { FtpOpError, type FileClient, type RawEntry } from './types.js';

type ResolvingClient = FileClient & { realpath: NonNullable<FileClient['realpath']> };

/** Wraps a client that can resolve paths; returns any other client unchanged. */
export function confine(client: FileClient, root: string): FileClient {
  return client.realpath === undefined
    ? client
    : new ConfinedClient(client as ResolvingClient, root);
}

class ConfinedClient implements FileClient {
  private realRoot: Promise<string> | undefined;

  constructor(
    private readonly inner: ResolvingClient,
    private readonly root: string,
  ) {}

  /**
   * Where `path` leads on the server. A path that does not exist yet (a file about to be
   * written, a directory about to be made) is its nearest existing ancestor, resolved, with
   * the missing names appended; nothing below that ancestor can be a link yet.
   */
  private async resolve(path: string): Promise<string> {
    const missing: string[] = [];
    let current = path;
    for (;;) {
      const real = await this.inner.realpath(current);
      if (real !== null) {
        return missing.length === 0 ? real : posix.join(real, ...missing.reverse());
      }
      const parent = posix.dirname(current);
      if (parent === current) {
        throw new Error(`cannot resolve ${path} on the server`);
      }
      missing.push(posix.basename(current));
      current = parent;
    }
  }

  private async check(path: string): Promise<void> {
    this.realRoot ??= this.resolve(this.root);
    const realRoot = await this.realRoot;
    const real = await this.resolve(path);
    const inside = realRoot === '/' || real === realRoot || real.startsWith(`${realRoot}/`);
    if (!inside) {
      throw new FtpOpError(
        'path',
        `invalid path ${JSON.stringify(path)}: resolves to ${real} on the server, ` +
          `outside the root (${realRoot}), through a symlink`,
      );
    }
  }

  async list(dir: string): Promise<RawEntry[]> {
    await this.check(dir);
    return this.inner.list(dir);
  }

  async stat(path: string): Promise<RawEntry | null> {
    await this.check(path);
    return this.inner.stat(path);
  }

  async read(path: string): Promise<Buffer> {
    await this.check(path);
    return this.inner.read(path);
  }

  async write(path: string, data: Buffer): Promise<void> {
    await this.check(path);
    return this.inner.write(path, data);
  }

  async upload(local: string, path: string): Promise<void> {
    await this.check(path);
    return this.inner.upload(local, path);
  }

  async remove(path: string): Promise<void> {
    await this.check(path);
    return this.inner.remove(path);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    await this.check(path);
    return this.inner.rmdir(path, recursive);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.check(from);
    await this.check(to);
    return this.inner.rename(from, to);
  }

  async replace(from: string, to: string): Promise<void> {
    await this.check(from);
    await this.check(to);
    return this.inner.replace(from, to);
  }

  async mkdir(path: string): Promise<void> {
    await this.check(path);
    return this.inner.mkdir(path);
  }

  realpath(path: string): Promise<string | null> {
    return this.inner.realpath(path);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
