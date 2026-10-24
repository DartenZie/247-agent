/**
 * Which failures of the mail libraries are transient, so the core retries the run
 * (docs/internal/connectors.md). A connection that failed, broke or timed out, a server
 * that is busy or throttling, and an SMTP 4xx reply are; a refused login, a bad address,
 * a TLS certificate that does not verify and an SMTP 5xx reply are not.
 */
import { isNetworkError, isTransient } from '@247-agent/connector-sdk';

/** imapflow's `code`s for a connection that is gone, timed out or throttled. */
const IMAP_CODES = new Set([
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
  'ETHROTTLE',
]);

/** IMAP response codes for a temporary condition (RFC 5530). */
const IMAP_RESPONSE_CODES = new Set(['UNAVAILABLE', 'INUSE']);

interface MailLibError {
  code?: unknown;
  /** nodemailer: the system error's code, which `code` replaced with its own. */
  originalCode?: unknown;
  /** nodemailer: the SMTP reply code. */
  responseCode?: unknown;
  /** imapflow: the tagged response's code. */
  serverResponseCode?: unknown;
}

export function isTransientMailError(err: unknown): boolean {
  if (isTransient(err) || isNetworkError(err)) {
    return true;
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as MailLibError;
  if (typeof e.responseCode === 'number') {
    return e.responseCode >= 400 && e.responseCode < 500;
  }
  if (e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT') {
    return true;
  }
  if (e.code === 'ESOCKET') {
    // Any socket error, a certificate that does not verify included: only a network one counts.
    return isNetworkError({ code: e.originalCode });
  }
  if (typeof e.code === 'string' && IMAP_CODES.has(e.code)) {
    return true;
  }
  return typeof e.serverResponseCode === 'string' && IMAP_RESPONSE_CODES.has(e.serverResponseCode);
}
