/**
 * Path confinement. Every user-supplied path is relative to the configured root and must
 * stay inside it; this module is the only place that decides what a path means. It is pure
 * and runs before any connection is opened, so a bad path never reaches a server.
 */
import { posix } from 'node:path';

import { FtpOpError } from './types.js';

export interface ResolvedPath {
  /** Normalised, relative to the root; `.` is the root itself. */
  rel: string;
  /** The path to hand to the server: root joined with `rel`. */
  remote: string;
}

/** Normalises a configured root: posix form, trailing slash removed (except for `/`). */
export function normalizeRoot(root: string): string {
  const n = posix.normalize(root === '' ? '.' : root);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

const invalid = (input: string, why: string): FtpOpError =>
  new FtpOpError('path', `invalid path ${JSON.stringify(input)}: ${why}`);

/** Resolves one user path against the root, or throws `FtpOpError('path')`. */
export function resolveRemote(root: string, input: string): ResolvedPath {
  if (input.includes('\0')) {
    throw invalid(input, 'contains a NUL byte');
  }
  if (input.includes('\\')) {
    throw invalid(input, 'backslashes are not allowed, use "/"');
  }
  if (input.startsWith('/')) {
    throw invalid(input, 'absolute paths are not allowed, paths are relative to the root');
  }
  let rel = posix.normalize(input === '' ? '.' : input);
  if (rel.length > 1 && rel.endsWith('/')) {
    rel = rel.slice(0, -1);
  }
  if (rel === '..' || rel.startsWith('../')) {
    throw invalid(input, 'escapes the root');
  }
  const remote = rel === '.' ? root : posix.join(root, rel);
  const inside =
    root === '.'
      ? remote === rel
      : remote === root || remote.startsWith(`${root}/`) || root === '/';
  if (!inside) {
    // Cannot happen after the checks above; kept as a last line of defence.
    throw invalid(input, 'escapes the root');
  }
  return { rel, remote };
}

/** The relative path of `name` inside the directory `rel` (`.` for the root). */
export function childPath(rel: string, name: string): string {
  return rel === '.' ? name : `${rel}/${name}`;
}

/** The relative parent of `rel`, or `null` when `rel` is the root itself. */
export function parentPath(rel: string): string | null {
  if (rel === '.') {
    return null;
  }
  const parent = posix.dirname(rel);
  return parent;
}
