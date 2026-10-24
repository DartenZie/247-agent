import { describe, expect, it } from 'vitest';

import { isTransientFileError } from './errors.js';

function libError(message: string, props: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), props);
}

describe('isTransientFileError', () => {
  it('takes connection failures, timeouts and FTP 4xx as transient', () => {
    for (const err of [
      libError('sftp: Remote host refused connection', { code: 'ECONNREFUSED' }),
      libError('sftp: Remote host has reset the connection', { code: 'ECONNRESET' }),
      libError('421 Service not available', { code: 421 }),
      libError('450 File busy', { code: 450 }),
      libError('Timeout (control socket)'),
      libError('Server sent FIN packet unexpectedly, closing connection.'),
      libError('sftp: Timed out while waiting for handshake', { code: 'ERR_GENERIC_CLIENT' }),
      libError('Timed out while waiting for handshake', { level: 'client-timeout' }),
    ]) {
      expect(isTransientFileError(err), err.message).toBe(true);
    }
  });

  it('keeps refused logins, missing files and FTP 5xx permanent', () => {
    for (const err of [
      libError('530 Login incorrect', { code: 530 }),
      libError('550 No such file', { code: 550 }),
      libError('No such file', { code: 2 }),
      libError('sftp: All configured authentication methods failed', { code: 'ERR_BAD_AUTH' }),
      libError('permission denied', { code: 'EACCES' }),
    ]) {
      expect(isTransientFileError(err), err.message).toBe(false);
    }
  });
});
