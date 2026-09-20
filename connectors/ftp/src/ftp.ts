/**
 * FTP and FTPS on `basic-ftp`. A narrow `FtpLib` slice of the library's `Client` is what
 * this module uses, so tests inject a fake through the factory instead of a server.
 *
 * Quirks handled here: there is no stat command, so `stat` lists the parent; downloads go
 * into a Writable and uploads come from a Readable; `ensureDir` changes the working
 * directory, which is restored so a relative root keeps working on the same connection.
 */
import { posix } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { Client, FileType } from 'basic-ftp';

import type { FtpConfig } from './config.js';
import type { FileClient, RawEntry } from './types.js';

export interface FtpAccessOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean | 'implicit';
  secureOptions: { rejectUnauthorized: boolean };
}

export interface FtpFileInfo {
  name: string;
  type: FileType;
  size: number;
  modifiedAt?: Date | undefined;
}

/** The slice of basic-ftp's `Client` this module uses, so tests can substitute a fake. */
export interface FtpLib {
  access(options: FtpAccessOptions): Promise<unknown>;
  list(path: string): Promise<FtpFileInfo[]>;
  downloadTo(destination: Writable, path: string): Promise<unknown>;
  uploadFrom(source: Readable, path: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
  removeDir(path: string): Promise<unknown>;
  removeEmptyDir(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  ensureDir(path: string): Promise<unknown>;
  pwd(): Promise<string>;
  cd(path: string): Promise<unknown>;
  close(): void;
}

export type FtpLibFactory = (timeoutMs: number) => FtpLib;

export const defaultFtpLibFactory: FtpLibFactory = (timeoutMs) => new Client(timeoutMs);

export function accessOptions(config: FtpConfig): FtpAccessOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.user ?? 'anonymous',
    password: config.password ?? 'guest',
    secure: config.protocol === 'ftps' ? (config.tls === 'implicit' ? 'implicit' : true) : false,
    secureOptions: { rejectUnauthorized: config.reject_unauthorized },
  };
}

function entryType(type: FileType): RawEntry['type'] {
  switch (type) {
    case FileType.Directory:
      return 'dir';
    case FileType.SymbolicLink:
      return 'symlink';
    default:
      return 'file';
  }
}

function toRaw(info: FtpFileInfo): RawEntry {
  return {
    name: info.name,
    type: entryType(info.type),
    size: info.size,
    mtime: info.modifiedAt ?? null,
  };
}

function describe(op: string, path: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`ftp ${op} ${path}: ${message}`);
}

export class FtpFileClient implements FileClient {
  constructor(
    private readonly lib: FtpLib,
    private readonly root: string,
  ) {}

  async list(dir: string): Promise<RawEntry[]> {
    let infos: FtpFileInfo[];
    try {
      infos = await this.lib.list(dir);
    } catch (err) {
      throw describe('list', dir, err);
    }
    return infos.filter((i) => i.name !== '.' && i.name !== '..').map(toRaw);
  }

  async stat(path: string): Promise<RawEntry | null> {
    if (path === this.root) {
      return { name: posix.basename(path), type: 'dir', size: 0, mtime: null };
    }
    const name = posix.basename(path);
    const siblings = await this.list(posix.dirname(path));
    return siblings.find((e) => e.name === name) ?? null;
  }

  async read(path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    try {
      await this.lib.downloadTo(sink, path);
    } catch (err) {
      throw describe('download', path, err);
    }
    return Buffer.concat(chunks);
  }

  async write(path: string, data: Buffer): Promise<void> {
    try {
      await this.lib.uploadFrom(Readable.from(data), path);
    } catch (err) {
      throw describe('upload', path, err);
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.lib.remove(path);
    } catch (err) {
      throw describe('remove', path, err);
    }
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    try {
      if (recursive) {
        await this.lib.removeDir(path);
      } else {
        await this.lib.removeEmptyDir(path);
      }
    } catch (err) {
      throw describe('rmdir', path, err);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await this.lib.rename(from, to);
    } catch (err) {
      throw describe('rename', from, err);
    }
  }

  async mkdir(path: string): Promise<void> {
    // ensureDir walks into the directory it creates; go back so later relative paths
    // still resolve against the login directory.
    let cwd: string;
    try {
      cwd = await this.lib.pwd();
      await this.lib.ensureDir(path);
      await this.lib.cd(cwd);
    } catch (err) {
      throw describe('mkdir', path, err);
    }
  }

  close(): Promise<void> {
    this.lib.close();
    return Promise.resolve();
  }
}

/** Connects with the config's credentials and returns a ready client. */
export async function connectFtp(
  config: FtpConfig,
  factory: FtpLibFactory = defaultFtpLibFactory,
): Promise<FileClient> {
  const lib = factory(config.timeout);
  try {
    await lib.access(accessOptions(config));
  } catch (err) {
    lib.close();
    throw describe('connect', `${config.host}:${String(config.port)}`, err);
  }
  return new FtpFileClient(lib, config.root);
}
