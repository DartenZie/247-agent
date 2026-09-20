/**
 * Shared shapes: the narrow file-system view both protocol adapters implement, the entry
 * shape ops return, and the typed error the ops layer raises.
 */
import type { JsonValue } from '@247-agent/connector-sdk';

import type { FtpConfig } from './config.js';

export type EntryType = 'file' | 'dir' | 'symlink';

/** One directory entry as a backend reports it (paths not yet resolved). */
export interface RawEntry {
  name: string;
  type: EntryType;
  size: number;
  mtime: Date | null;
}

/** One entry as it lands in an op result; `path` is relative to the configured root. */
export interface FileEntry {
  name: string;
  path: string;
  type: EntryType;
  size: number;
  /** ISO 8601, or null when the server does not report it (FTP without MLSD). */
  mtime: string | null;
  [key: string]: JsonValue;
}

/**
 * What the ops need from one connected session, whatever the protocol. Every path is
 * already joined with the root; the adapters never see user input.
 */
export interface FileClient {
  list(dir: string): Promise<RawEntry[]>;
  /** `null` when the path does not exist; anything else throws. */
  stat(path: string): Promise<RawEntry | null>;
  read(path: string): Promise<Buffer>;
  /** Creates or overwrites. */
  write(path: string, data: Buffer): Promise<void>;
  /** Removes one file or symlink. */
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** `mkdir -p`: creates parents, succeeds when the directory exists. */
  mkdir(path: string): Promise<void>;
  close(): Promise<void>;
}

/** Connects and returns a ready client; the ops layer calls `close()` when done. */
export type FileClientFactory = (config: FtpConfig) => Promise<FileClient>;

export type FtpOpErrorCode = 'not_found' | 'too_large' | 'exists' | 'path' | 'not_empty';

/** A readable, typed failure of one op; the message is what the calling run sees. */
export class FtpOpError extends Error {
  constructor(
    readonly code: FtpOpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FtpOpError';
  }
}

/** Whether a library error means "no such file or directory". */
export function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === 'ENOENT' || code === 2) {
    return true;
  }
  return typeof message === 'string' && /no such file/i.test(message);
}

export type Log = (line: string) => void;

// Op inputs and outputs. Results carry an index signature so they are assignable to
// `JsonValue` at the tool boundary.

export type Encoding = 'utf8' | 'base64';

export interface ListArgs {
  path?: string | undefined;
  limit?: number | undefined;
}

export interface ListResult {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
  [key: string]: JsonValue;
}

export interface StatArgs {
  path: string;
}

export type StatResult = ({ path: string; exists: false } | ({ exists: true } & FileEntry)) &
  Record<string, JsonValue>;

export interface ReadArgs {
  path: string;
  encoding?: Encoding | undefined;
}

export interface ReadResult {
  path: string;
  content: string;
  encoding: Encoding;
  size: number;
  [key: string]: JsonValue;
}

export interface WriteArgs {
  path: string;
  content: string;
  encoding?: Encoding | undefined;
  parents?: boolean | undefined;
  overwrite?: boolean | undefined;
}

export interface WriteResult {
  path: string;
  size: number;
  [key: string]: JsonValue;
}

export interface DeleteArgs {
  path: string;
  recursive?: boolean | undefined;
  missing_ok?: boolean | undefined;
}

export interface DeleteResult {
  path: string;
  deleted: boolean;
  type: EntryType | null;
  [key: string]: JsonValue;
}

export interface RenameArgs {
  from: string;
  to: string;
  parents?: boolean | undefined;
}

export interface RenameResult {
  from: string;
  to: string;
  [key: string]: JsonValue;
}

export interface MkdirArgs {
  path: string;
}

export interface MkdirResult {
  path: string;
  [key: string]: JsonValue;
}
