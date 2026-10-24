/**
 * Which failures of the (S)FTP libraries are transient, so the core retries the run
 * (docs/internal/connectors.md). A connection that failed, broke or timed out and an FTP
 * 4xx reply (421 service not available, 425, 426, 450, 451, 452) are; a refused login, a
 * missing file, a denied permission and an FTP 5xx reply are not.
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

export function isTransientFileError(err: unknown): boolean {
  if (isTransient(err) || isNetworkError(err)) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  const { code, level } = err as { code?: unknown; level?: unknown };
  // basic-ftp's FTPError carries the reply code; SFTP status codes are below 100.
  if (typeof code === 'number' && code >= 400 && code < 500) {
    return true;
  }
  if (level === 'client-timeout' || level === 'client-socket') {
    return true;
  }
  return BROKEN.some((re) => re.test(err.message));
}
