/** An in-memory `FileClient` and config helpers for the tests. */
import { posix } from 'node:path';

import { parseConfig, type FtpConfig } from './config.js';
import type { FileClient, RawEntry } from './types.js';

export function ftpConfig(extra: Record<string, unknown> = {}): FtpConfig {
  return parseConfig({ host: 'h', user: 'u', password: 'p', ...extra });
}

const MTIME = new Date('2026-06-01T08:00:00.000Z');

/**
 * Files in a map, directories in a set, every call traced. Paths are whatever the ops
 * hand over (already root-joined), so the fake does not care what the root is.
 */
export class MemoryFileClient implements FileClient {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();
  readonly calls: string[] = [];
  closed = false;

  constructor(seed: Record<string, string> = {}, root = '.') {
    this.dirs.add(root);
    for (const [path, content] of Object.entries(seed)) {
      this.seed(path, content);
    }
  }

  seed(path: string, content: string): void {
    this.files.set(path, Buffer.from(content));
    let dir = posix.dirname(path);
    while (dir !== '.' && dir !== '/' && !this.dirs.has(dir)) {
      this.dirs.add(dir);
      dir = posix.dirname(dir);
    }
  }

  private isDir(path: string): boolean {
    return this.dirs.has(path);
  }

  list(dir: string): Promise<RawEntry[]> {
    this.calls.push(`list ${dir}`);
    if (!this.isDir(dir)) {
      return Promise.reject(new Error(`no such directory: ${dir}`));
    }
    const out: RawEntry[] = [];
    const prefix = dir === '.' ? '' : `${dir}/`;
    const direct = (p: string): boolean =>
      p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p !== dir;
    for (const [p, data] of this.files) {
      if (direct(p)) {
        out.push({ name: posix.basename(p), type: 'file', size: data.length, mtime: MTIME });
      }
    }
    for (const d of this.dirs) {
      if (direct(d)) {
        out.push({ name: posix.basename(d), type: 'dir', size: 0, mtime: null });
      }
    }
    return Promise.resolve(out);
  }

  stat(path: string): Promise<RawEntry | null> {
    this.calls.push(`stat ${path}`);
    const data = this.files.get(path);
    if (data !== undefined) {
      return Promise.resolve({
        name: posix.basename(path),
        type: 'file',
        size: data.length,
        mtime: MTIME,
      });
    }
    if (this.isDir(path)) {
      return Promise.resolve({ name: posix.basename(path), type: 'dir', size: 0, mtime: null });
    }
    return Promise.resolve(null);
  }

  read(path: string): Promise<Buffer> {
    this.calls.push(`read ${path}`);
    const data = this.files.get(path);
    return data === undefined
      ? Promise.reject(new Error(`no such file: ${path}`))
      : Promise.resolve(data);
  }

  write(path: string, data: Buffer): Promise<void> {
    this.calls.push(`write ${path}`);
    const parent = posix.dirname(path);
    if (!this.isDir(parent)) {
      return Promise.reject(new Error(`no such directory: ${parent}`));
    }
    this.files.set(path, data);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.calls.push(`remove ${path}`);
    if (!this.files.delete(path)) {
      return Promise.reject(new Error(`no such file: ${path}`));
    }
    return Promise.resolve();
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    this.calls.push(`rmdir ${path} recursive=${String(recursive)}`);
    if (!this.isDir(path)) {
      return Promise.reject(new Error(`no such directory: ${path}`));
    }
    const inside = (p: string): boolean => p.startsWith(`${path}/`);
    const children = [...this.files.keys(), ...this.dirs].filter(inside);
    if (children.length > 0 && !recursive) {
      return Promise.reject(new Error(`directory not empty: ${path}`));
    }
    for (const c of children) {
      this.files.delete(c);
      this.dirs.delete(c);
    }
    this.dirs.delete(path);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} ${to}`);
    const data = this.files.get(from);
    if (data !== undefined) {
      if (!this.isDir(posix.dirname(to))) {
        return Promise.reject(new Error(`no such directory: ${posix.dirname(to)}`));
      }
      this.files.delete(from);
      this.files.set(to, data);
      return Promise.resolve();
    }
    if (this.isDir(from)) {
      const moved = [...this.files.entries()].filter(([p]) => p.startsWith(`${from}/`));
      for (const [p, d] of moved) {
        this.files.delete(p);
        this.files.set(`${to}${p.slice(from.length)}`, d);
      }
      for (const d of [...this.dirs].filter((d) => d === from || d.startsWith(`${from}/`))) {
        this.dirs.delete(d);
        this.dirs.add(`${to}${d.slice(from.length)}`);
      }
      return Promise.resolve();
    }
    return Promise.reject(new Error(`no such file: ${from}`));
  }

  mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir ${path}`);
    let dir = path;
    while (dir !== '.' && dir !== '/' && !this.dirs.has(dir)) {
      this.dirs.add(dir);
      dir = posix.dirname(dir);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.push('close');
    this.closed = true;
    return Promise.resolve();
  }
}
