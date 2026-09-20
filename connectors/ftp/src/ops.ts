/**
 * The seven ops, independent of the protocol. Each call opens one connection through the
 * factory and closes it in `finally`, so the process stays stateless and restart-safe
 * (the same choice the email connector makes). Paths are resolved against the root
 * before the factory runs, so an escaping path never opens a connection.
 */
import { posix } from 'node:path';

import type { FtpConfig } from './config.js';
import { childPath, parentPath, resolveRemote } from './paths.js';
import {
  FtpOpError,
  type DeleteArgs,
  type DeleteResult,
  type Encoding,
  type FileClient,
  type FileClientFactory,
  type FileEntry,
  type ListArgs,
  type ListResult,
  type Log,
  type MkdirArgs,
  type MkdirResult,
  type RawEntry,
  type ReadArgs,
  type ReadResult,
  type RenameArgs,
  type RenameResult,
  type StatArgs,
  type StatResult,
  type WriteArgs,
  type WriteResult,
} from './types.js';

function toEntry(rel: string, raw: RawEntry): FileEntry {
  return {
    name: raw.name,
    path: rel,
    type: raw.type,
    size: raw.size,
    mtime: raw.mtime === null ? null : raw.mtime.toISOString(),
  };
}

export class FileOps {
  constructor(
    private readonly config: FtpConfig,
    private readonly log: Log,
    private readonly factory: FileClientFactory,
  ) {}

  private resolve(input: string | undefined): { rel: string; remote: string } {
    return resolveRemote(this.config.root, input ?? '.');
  }

  private async withClient<T>(fn: (client: FileClient) => Promise<T>): Promise<T> {
    const client = await this.factory(this.config);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private checkSize(rel: string, size: number): void {
    if (size > this.config.max_bytes) {
      throw new FtpOpError(
        'too_large',
        `${rel}: ${String(size)} bytes exceeds max_bytes (${String(this.config.max_bytes)})`,
      );
    }
  }

  async list(args: ListArgs): Promise<ListResult> {
    const { rel, remote } = this.resolve(args.path);
    const limit = Math.min(args.limit ?? this.config.list_limit, this.config.list_limit);
    return this.withClient(async (client) => {
      const raw = await client.list(remote);
      const sorted = [...raw].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const entries = sorted.slice(0, limit).map((e) => toEntry(childPath(rel, e.name), e));
      this.log(`ftp: list ${rel} -> ${String(entries.length)} of ${String(raw.length)}`);
      return { path: rel, entries, truncated: sorted.length > limit };
    });
  }

  async stat(args: StatArgs): Promise<StatResult> {
    const { rel, remote } = this.resolve(args.path);
    return this.withClient(async (client) => {
      const raw = await client.stat(remote);
      if (raw === null) {
        return { path: rel, exists: false };
      }
      return { exists: true, ...toEntry(rel, raw) };
    });
  }

  async read(args: ReadArgs): Promise<ReadResult> {
    const { rel, remote } = this.resolve(args.path);
    const encoding: Encoding = args.encoding ?? 'utf8';
    return this.withClient(async (client) => {
      const existing = await client.stat(remote);
      if (existing === null) {
        throw new FtpOpError('not_found', `${rel}: not found`);
      }
      if (existing.type === 'dir') {
        throw new FtpOpError('path', `${rel}: is a directory`);
      }
      // Refuse before the transfer when the listing knows the size; FTP cannot stop
      // half-way, so the check is repeated on what actually arrived.
      this.checkSize(rel, existing.size);
      const data = await client.read(remote);
      this.checkSize(rel, data.length);
      this.log(`ftp: read ${rel} ${String(data.length)} bytes`);
      return { path: rel, content: data.toString(encoding), encoding, size: data.length };
    });
  }

  async write(args: WriteArgs): Promise<WriteResult> {
    const { rel, remote } = this.resolve(args.path);
    const encoding: Encoding = args.encoding ?? 'utf8';
    const data = Buffer.from(args.content, encoding);
    this.checkSize(rel, data.length);
    const parent = parentPath(rel);
    return this.withClient(async (client) => {
      if (args.overwrite === false) {
        const existing = await client.stat(remote);
        if (existing !== null) {
          throw new FtpOpError('exists', `${rel}: already exists and overwrite is false`);
        }
      }
      if ((args.parents ?? true) && parent !== null && parent !== '.') {
        await client.mkdir(posix.join(this.config.root, parent));
      }
      await client.write(remote, data);
      this.log(`ftp: write ${rel} ${String(data.length)} bytes`);
      return { path: rel, size: data.length };
    });
  }

  async delete(args: DeleteArgs): Promise<DeleteResult> {
    const { rel, remote } = this.resolve(args.path);
    if (rel === '.') {
      throw new FtpOpError('path', 'refusing to delete the root directory');
    }
    return this.withClient(async (client) => {
      const existing = await client.stat(remote);
      if (existing === null) {
        if (args.missing_ok === true) {
          return { path: rel, deleted: false, type: null };
        }
        throw new FtpOpError('not_found', `${rel}: not found`);
      }
      if (existing.type === 'dir') {
        await client.rmdir(remote, args.recursive ?? false);
      } else {
        await client.remove(remote);
      }
      this.log(`ftp: delete ${rel} (${existing.type})`);
      return { path: rel, deleted: true, type: existing.type };
    });
  }

  async rename(args: RenameArgs): Promise<RenameResult> {
    const from = this.resolve(args.from);
    const to = this.resolve(args.to);
    if (from.rel === '.' || to.rel === '.') {
      throw new FtpOpError('path', 'refusing to rename the root directory');
    }
    const parent = parentPath(to.rel);
    return this.withClient(async (client) => {
      if (args.parents === true && parent !== null && parent !== '.') {
        await client.mkdir(posix.join(this.config.root, parent));
      }
      await client.rename(from.remote, to.remote);
      this.log(`ftp: rename ${from.rel} -> ${to.rel}`);
      return { from: from.rel, to: to.rel };
    });
  }

  async mkdir(args: MkdirArgs): Promise<MkdirResult> {
    const { rel, remote } = this.resolve(args.path);
    return this.withClient(async (client) => {
      await client.mkdir(remote);
      this.log(`ftp: mkdir ${rel}`);
      return { path: rel };
    });
  }
}
