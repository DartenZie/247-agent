/**
 * SFTP on `ssh2-sftp-client`. A narrow `SftpLib` slice of the library is what this module
 * uses, so tests inject a fake through the factory instead of a server.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import SftpClient from 'ssh2-sftp-client';

import type { FtpConfig } from './config.js';
import { isNotFound, type FileClient, type RawEntry } from './types.js';

export interface SftpConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  readyTimeout: number;
  hostVerifier?: (key: Buffer) => boolean;
}

export interface SftpFileInfo {
  type: string;
  name: string;
  size: number;
  /** Milliseconds since the epoch. */
  modifyTime: number;
}

export interface SftpFileStats {
  size: number;
  modifyTime: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** The slice of `ssh2-sftp-client` this module uses, so tests can substitute a fake. */
export interface SftpLib {
  connect(options: SftpConnectOptions): Promise<unknown>;
  list(path: string): Promise<SftpFileInfo[]>;
  stat(path: string): Promise<SftpFileStats>;
  get(path: string): Promise<unknown>;
  put(input: Buffer, path: string): Promise<unknown>;
  delete(path: string): Promise<unknown>;
  rmdir(path: string, recursive?: boolean): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  mkdir(path: string, recursive?: boolean): Promise<unknown>;
  end(): Promise<unknown>;
}

export type SftpLibFactory = () => SftpLib;

export const defaultSftpLibFactory: SftpLibFactory = () => new SftpClient();

/**
 * Compares a host key against the configured fingerprint, which may be `SHA256:<base64>`
 * (as `ssh-keygen -lf` prints it, padding optional) or plain hex.
 */
export function hostKeyMatches(key: Buffer, expected: string): boolean {
  const digest = createHash('sha256').update(key).digest();
  const wanted = expected
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
  const asBase64 = digest.toString('base64').replace(/=+$/, '');
  const asHex = digest.toString('hex');
  return wanted === asBase64 || wanted.toLowerCase().replace(/:/g, '') === asHex;
}

function connectOptions(config: FtpConfig): SftpConnectOptions {
  const options: SftpConnectOptions = {
    host: config.host,
    port: config.port,
    username: config.user ?? '',
    readyTimeout: config.timeout,
  };
  if (config.password !== undefined) {
    options.password = config.password;
  }
  if (config.private_key !== undefined) {
    options.privateKey = config.private_key;
  }
  if (config.passphrase !== undefined) {
    options.passphrase = config.passphrase;
  }
  const fingerprint = config.host_key_fingerprint;
  if (fingerprint !== undefined) {
    options.hostVerifier = (key) => hostKeyMatches(key, fingerprint);
  }
  return options;
}

function entryType(type: string): RawEntry['type'] {
  return type === 'd' ? 'dir' : type === 'l' ? 'symlink' : 'file';
}

function describe(op: string, path: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`sftp ${op} ${path}: ${message}`);
}

export class SftpFileClient implements FileClient {
  constructor(private readonly lib: SftpLib) {}

  async list(dir: string): Promise<RawEntry[]> {
    let infos: SftpFileInfo[];
    try {
      infos = await this.lib.list(dir);
    } catch (err) {
      throw describe('list', dir, err);
    }
    return infos.map((i) => ({
      name: i.name,
      type: entryType(i.type),
      size: i.size,
      mtime: new Date(i.modifyTime),
    }));
  }

  async stat(path: string): Promise<RawEntry | null> {
    let s: SftpFileStats;
    try {
      s = await this.lib.stat(path);
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw describe('stat', path, err);
    }
    return {
      name: posix.basename(path),
      type: s.isDirectory ? 'dir' : s.isSymbolicLink ? 'symlink' : 'file',
      size: s.size,
      mtime: new Date(s.modifyTime),
    };
  }

  async read(path: string): Promise<Buffer> {
    let result: unknown;
    try {
      result = await this.lib.get(path);
    } catch (err) {
      throw describe('get', path, err);
    }
    if (!Buffer.isBuffer(result)) {
      throw new Error(`sftp get ${path}: expected a Buffer from the library`);
    }
    return result;
  }

  async write(path: string, data: Buffer): Promise<void> {
    try {
      await this.lib.put(data, path);
    } catch (err) {
      throw describe('put', path, err);
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.lib.delete(path);
    } catch (err) {
      throw describe('delete', path, err);
    }
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    try {
      await this.lib.rmdir(path, recursive);
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
    try {
      await this.lib.mkdir(path, true);
    } catch (err) {
      throw describe('mkdir', path, err);
    }
  }

  async close(): Promise<void> {
    await this.lib.end();
  }
}

/** Connects with the config's credentials and returns a ready client. */
export async function connectSftp(
  config: FtpConfig,
  factory: SftpLibFactory = defaultSftpLibFactory,
): Promise<FileClient> {
  const lib = factory();
  try {
    await lib.connect(connectOptions(config));
  } catch (err) {
    throw describe('connect', `${config.host}:${String(config.port)}`, err);
  }
  return new SftpFileClient(lib);
}
