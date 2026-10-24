import { describe, expect, it } from 'vitest';

import { isTransientFileError } from './errors.js';

function libError(message: string, props: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), props);
}

const read = { repeatable: true };
const write = { repeatable: false };

describe('isTransientFileError', () => {
  it('takes connection failures, timeouts and FTP 4xx of a repeatable step as transient', () => {
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
      expect(isTransientFileError(err, read), err.message).toBe(true);
    }
  });

  it('takes only a 4xx that comes before any change as transient for a write', () => {
    expect(isTransientFileError(libError('450 File busy', { code: 450 }), write)).toBe(true);
    expect(isTransientFileError(libError('425 No data connection', { code: 425 }), write)).toBe(
      true,
    );
    expect(isTransientFileError(libError('451 Aborted', { code: 451 }), write)).toBe(false);
    expect(isTransientFileError(libError('426 Transfer aborted', { code: 426 }), write)).toBe(
      false,
    );
    expect(isTransientFileError(libError('read ECONNRESET', { code: 'ECONNRESET' }), write)).toBe(
      false,
    );
    expect(isTransientFileError(libError('Timeout (data socket)'), write)).toBe(false);
  });

  it('keeps refused logins, missing files and FTP 5xx permanent', () => {
    for (const err of [
      libError('530 Login incorrect', { code: 530 }),
      libError('550 No such file', { code: 550 }),
      libError('No such file', { code: 2 }),
      libError('sftp: All configured authentication methods failed', { code: 'ERR_BAD_AUTH' }),
      libError('permission denied', { code: 'EACCES' }),
    ]) {
      expect(isTransientFileError(err, read), err.message).toBe(false);
    }
  });
});
