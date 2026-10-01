import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseConfig, type VerifyConfig } from './config.js';
import { verifyRequest } from './verify.js';

const body = Buffer.from('{"zen":"Keep it logically awesome."}');

function verifyOf(verify: unknown): VerifyConfig {
  const route = parseConfig({ routes: [{ path: '/h', event: 'x', verify }] }).routes[0];
  if (route === undefined) {
    throw new Error('no route');
  }
  return route.verify;
}

function sign(secret: string, algo = 'sha256', data: Buffer = body): Buffer {
  return createHmac(algo, secret).update(data).digest();
}

describe('verifyRequest', () => {
  it('checks a GitHub signature', () => {
    const v = verifyOf({ kind: 'github', secret: 'topsecret' });
    const good = `sha256=${sign('topsecret').toString('hex')}`;
    expect(verifyRequest(v, { 'x-hub-signature-256': good }, body)).toEqual({ ok: true });
    expect(
      verifyRequest(v, { 'x-hub-signature-256': good }, Buffer.from(body.toString() + ' ')),
    ).toEqual({ ok: false, reason: 'signature mismatch' });
    expect(verifyRequest(v, {}, body)).toEqual({
      ok: false,
      reason: 'missing x-hub-signature-256',
    });
    expect(verifyRequest(v, { 'x-hub-signature-256': 'sha1=00' }, body).ok).toBe(false);
    expect(verifyRequest(v, { 'x-hub-signature-256': 'sha256=zz' }, body).ok).toBe(false);
  });

  it('checks a generic HMAC in base64 without a prefix', () => {
    const v = verifyOf({
      kind: 'hmac',
      secret: 'k',
      header: 'X-Signature',
      algorithm: 'sha512',
      encoding: 'base64',
    });
    const good = sign('k', 'sha512').toString('base64');
    expect(verifyRequest(v, { 'x-signature': good }, body)).toEqual({ ok: true });
    expect(
      verifyRequest(v, { 'x-signature': sign('other', 'sha512').toString('base64') }, body),
    ).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('checks a bearer token and a GitLab token', () => {
    const bearer = verifyOf({ kind: 'token', token: 'abc' });
    expect(verifyRequest(bearer, { authorization: 'Bearer abc' }, body)).toEqual({ ok: true });
    expect(verifyRequest(bearer, { authorization: 'bearer abc' }, body)).toEqual({ ok: true });
    expect(verifyRequest(bearer, { authorization: 'Bearer abcd' }, body).ok).toBe(false);
    expect(verifyRequest(bearer, { authorization: 'abc' }, body).ok).toBe(false);
    const gitlab = verifyOf({ kind: 'gitlab', token: 'glt' });
    expect(verifyRequest(gitlab, { 'x-gitlab-token': 'glt' }, body)).toEqual({ ok: true });
    expect(verifyRequest(gitlab, { 'x-gitlab-token': 'gl' }, body).ok).toBe(false);
  });

  it('checks a raw token in a custom header', () => {
    const v = verifyOf({ kind: 'token', token: 'abc', header: 'X-Token', scheme: '' });
    expect(verifyRequest(v, { 'x-token': 'abc' }, body)).toEqual({ ok: true });
    expect(verifyRequest(v, { 'x-token': 'Bearer abc' }, body).ok).toBe(false);
  });

  it('lets anything through with none', () => {
    expect(verifyRequest({ kind: 'none' }, {}, body)).toEqual({ ok: true });
  });
});
