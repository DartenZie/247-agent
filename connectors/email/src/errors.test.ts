import { describe, expect, it } from 'vitest';

import { TransientError } from '@247-agent/connector-sdk';

import { isTransientMailError } from './errors.js';

/** An error with the properties the mail libraries attach. */
function libError(props: Record<string, unknown>): Error {
  return Object.assign(new Error('x'), props);
}

describe('isTransientMailError', () => {
  it('takes connection failures, timeouts, throttling and SMTP 4xx as transient', () => {
    for (const props of [
      { code: 'ECONNREFUSED' },
      { code: 'ECONNECTION' },
      { code: 'ETIMEDOUT' },
      { code: 'ESOCKET', originalCode: 'ECONNRESET' },
      { code: 'EENVELOPE', responseCode: 452 },
      { code: 'EAUTH', responseCode: 454 },
      { code: 'NoConnection' },
      { code: 'CONNECT_TIMEOUT' },
      { code: 'ETHROTTLE' },
      { serverResponseCode: 'UNAVAILABLE' },
    ]) {
      expect(isTransientMailError(libError(props)), JSON.stringify(props)).toBe(true);
    }
    expect(isTransientMailError(new TransientError('pop3: connection closed'))).toBe(true);
  });

  it('keeps refused logins, bad addresses, certificate errors and SMTP 5xx permanent', () => {
    for (const props of [
      {},
      { code: 'EAUTH', responseCode: 535 },
      { code: 'EENVELOPE', responseCode: 550 },
      { code: 'EENVELOPE' },
      { code: 'ESOCKET', originalCode: 'CERT_HAS_EXPIRED' },
      { code: 'ESOCKET' },
      { code: 'ETLS' },
      { code: 'ENOTFOUND' },
      { serverResponseCode: 'AUTHENTICATIONFAILED' },
    ]) {
      expect(isTransientMailError(libError(props)), JSON.stringify(props)).toBe(false);
    }
    expect(isTransientMailError('boom')).toBe(false);
  });
});
