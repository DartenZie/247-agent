import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseConfig, type VerifyConfig } from './config.js';
import { checkHeaders, verifyRequest } from './verify.js';

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

const NOW = new Date('2026-09-30T12:00:00Z');
const TS = String(NOW.getTime() / 1000);

function signed(secret: string, before: string, after = ''): string {
  return sign(
    secret,
    'sha256',
    Buffer.concat([Buffer.from(before), body, Buffer.from(after)]),
  ).toString('hex');
}

describe('verifyRequest with a timestamp', () => {
  it('checks a Slack signature over v0:<timestamp>:<body> inside the window', () => {
    const v = verifyOf({ kind: 'slack', secret: 'sl' });
    const headers = (ts: string, sig = signed('sl', `v0:${ts}:`)) => ({
      'x-slack-request-timestamp': ts,
      'x-slack-signature': `v0=${sig}`,
    });
    expect(verifyRequest(v, headers(TS), body, NOW)).toEqual({ ok: true });
    // The same signature over the body alone does not pass.
    expect(verifyRequest(v, headers(TS, signed('sl', '')), body, NOW)).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    // A replay older than the default 300 s window, or a timestamp too far ahead.
    const old = String(Number(TS) - 301);
    expect(verifyRequest(v, headers(old), body, NOW)).toEqual({
      ok: false,
      reason: 'timestamp outside the 300 s window',
    });
    const ahead = String(Number(TS) + 301);
    expect(verifyRequest(v, headers(ahead), body, NOW).ok).toBe(false);
    expect(verifyRequest(v, headers(String(Number(TS) - 299)), body, NOW)).toEqual({ ok: true });
    expect(
      verifyRequest(v, { 'x-slack-signature': `v0=${signed('sl', `v0:${TS}:`)}` }, body, NOW),
    ).toEqual({ ok: false, reason: 'missing x-slack-request-timestamp' });
    expect(verifyRequest(v, headers('soon'), body, NOW)).toEqual({
      ok: false,
      reason: 'x-slack-request-timestamp is not a Unix time in seconds',
    });
  });

  it('checks a Stripe signature with t= and any of several v1= values', () => {
    const v = verifyOf({ kind: 'stripe', secret: 'whsec', tolerance: 60 });
    const good = signed('whsec', `${TS}.`);
    const other = signed('rotated', `${TS}.`);
    expect(
      verifyRequest(v, { 'stripe-signature': `t=${TS},v1=${other},v1=${good},v0=ab` }, body, NOW),
    ).toEqual({ ok: true });
    expect(verifyRequest(v, { 'stripe-signature': `t=${TS},v1=${other}` }, body, NOW)).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    const old = String(Number(TS) - 61);
    expect(
      verifyRequest(
        v,
        { 'stripe-signature': `t=${old},v1=${signed('whsec', `${old}.`)}` },
        body,
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'timestamp outside the 60 s window' });
    expect(verifyRequest(v, { 'stripe-signature': `v1=${good}` }, body, NOW)).toEqual({
      ok: false,
      reason: 'stripe-signature has no t=',
    });
    expect(verifyRequest(v, { 'stripe-signature': `t=${TS}` }, body, NOW)).toEqual({
      ok: false,
      reason: 'stripe-signature has no v1=',
    });
  });

  it('checks a generic HMAC over a configured timestamp layout', () => {
    const v = verifyOf({
      kind: 'hmac',
      secret: 'k',
      header: 'X-Sig',
      timestamp: { header: 'X-Ts', signed: 'ts={timestamp};{body};end', tolerance: 10 },
    });
    const sig = signed('k', `ts=${TS};`, ';end');
    expect(verifyRequest(v, { 'x-sig': sig, 'x-ts': TS }, body, NOW)).toEqual({ ok: true });
    expect(verifyRequest(v, { 'x-sig': sig, 'x-ts': String(Number(TS) + 1) }, body, NOW).ok).toBe(
      false,
    );
    const late = new Date(NOW.getTime() + 11_000);
    expect(verifyRequest(v, { 'x-sig': sig, 'x-ts': TS }, body, late)).toEqual({
      ok: false,
      reason: 'timestamp outside the 10 s window',
    });
  });
});

describe('checkHeaders', () => {
  it('settles a token check without the body', () => {
    const v = verifyOf({ kind: 'token', token: 'abc' });
    expect(checkHeaders(v, { authorization: 'Bearer abc' }, NOW)).toEqual({ ok: true });
    expect(checkHeaders(v, { authorization: 'Bearer abd' }, NOW)).toEqual({
      ok: false,
      reason: 'token mismatch',
    });
  });

  it('rejects a missing or malformed signature and a stale timestamp, passes the rest', () => {
    const gh = verifyOf({ kind: 'github', secret: 's' });
    expect(checkHeaders(gh, {}, NOW)).toEqual({ ok: false, reason: 'missing x-hub-signature-256' });
    expect(checkHeaders(gh, { 'x-hub-signature-256': 'sha256=zz' }, NOW)).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    // Well-formed but wrong: only the body can tell.
    expect(checkHeaders(gh, { 'x-hub-signature-256': `sha256=${'00'.repeat(32)}` }, NOW)).toEqual({
      ok: true,
    });
    const slack = verifyOf({ kind: 'slack', secret: 'sl' });
    const old = String(Number(TS) - 3600);
    expect(
      checkHeaders(slack, { 'x-slack-request-timestamp': old, 'x-slack-signature': 'v0=00' }, NOW),
    ).toEqual({ ok: false, reason: 'timestamp outside the 300 s window' });
    expect(checkHeaders({ kind: 'none' }, {}, NOW)).toEqual({ ok: true });
  });
});
