/**
 * Which failures of the (S)FTP libraries are transient, so the core retries the run
 * (docs/internal/connectors.md). A retry repeats the whole op, so a failure is transient
 * only when the op did not take effect or can run twice:
 *
 * - connecting, and the read-only steps (list, stat, download): any FTP 4xx reply (421
 *   service not available, 425, 426, 450 file busy, 451, 452), and a connection that
 *   failed, broke or timed out;
 * - a write (upload, delete, rename, mkdir): only 425 (no data connection) and 450 (file
 *   busy), which come before anything changed. A 421, 426, 451 or 452 and a broken
 *   connection may follow a partial upload. A refused login, a missing file and a 5xx
 *   are never transient.
 */
import { isNetworkError, isTransient } from '@247-agent/connector-sdk';

/** What basic-ftp and ssh2 say when a connection timed out or broke; they set no code. */
const BROKEN = [
  /^Timeout \(/,
  /^Server sent FIN packet unexpectedly/,
  /^Server closed connection unexpectedly/,
  /^Socket closed due to transmission error/,
  /Timed out while waiting for handshake/,
  /No response from server/,
];

export function isTransientFileError(err: unknown, opts: { repeatable: boolean }): boolean {
  if (isTransient(err)) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  const { code, level } = err as { code?: unknown; level?: unknown };
  // basic-ftp's FTPError carries the reply code; SFTP status codes are below 100.
  if (typeof code === 'number' && code >= 400 && code < 500) {
    return opts.repeatable || code === 425 || code === 450;
  }
  if (!opts.repeatable) {
    return false;
  }
  if (isNetworkError(err) || level === 'client-timeout' || level === 'client-socket') {
    return true;
  }
  return BROKEN.some((re) => re.test(err.message));
}
