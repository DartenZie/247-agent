/**
 * Request authentication per route: an HMAC of the raw body (GitHub and any service that
 * signs the same way) or a shared token in a header (GitLab, a bearer token). Every
 * comparison is constant-time and nothing about the expected value leaks into the error.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { VerifyConfig } from './config.js';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Checks one request against its route's `verify`; `body` is the raw bytes as received. */
export function verifyRequest(
  verify: VerifyConfig,
  headers: IncomingHttpHeaders,
  body: Buffer,
): VerifyResult {
  switch (verify.kind) {
    case 'none':
      return { ok: true };
    case 'github':
      return checkHmac(headers, body, {
        secret: verify.secret,
        header: 'x-hub-signature-256',
        algorithm: 'sha256',
        encoding: 'hex',
        prefix: 'sha256=',
      });
    case 'hmac':
      return checkHmac(headers, body, verify);
    case 'gitlab':
      return checkToken(headers, { token: verify.token, header: 'x-gitlab-token', scheme: '' });
    case 'token':
      return checkToken(headers, verify);
  }
}

function checkHmac(
  headers: IncomingHttpHeaders,
  body: Buffer,
  opts: {
    secret: string;
    header: string;
    algorithm: string;
    encoding: 'hex' | 'base64';
    prefix: string;
  },
): VerifyResult {
  const value = single(headers[opts.header]);
  if (value === undefined) {
    return { ok: false, reason: `missing ${opts.header}` };
  }
  if (!value.startsWith(opts.prefix)) {
    return { ok: false, reason: `${opts.header} does not start with "${opts.prefix}"` };
  }
  const given = decode(value.slice(opts.prefix.length).trim(), opts.encoding);
  const expected = createHmac(opts.algorithm, opts.secret).update(body).digest();
  if (given === undefined || !safeEqual(given, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

function checkToken(
  headers: IncomingHttpHeaders,
  opts: { token: string; header: string; scheme: string },
): VerifyResult {
  const value = single(headers[opts.header]);
  if (value === undefined) {
    return { ok: false, reason: `missing ${opts.header}` };
  }
  let given = value.trim();
  if (opts.scheme !== '') {
    const [scheme, ...rest] = given.split(/\s+/);
    if (scheme?.toLowerCase() !== opts.scheme.toLowerCase() || rest.length !== 1) {
      return { ok: false, reason: `${opts.header} is not "${opts.scheme} <token>"` };
    }
    given = rest[0] ?? '';
  }
  if (!safeEqual(Buffer.from(given), Buffer.from(opts.token))) {
    return { ok: false, reason: 'token mismatch' };
  }
  return { ok: true };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decode(text: string, encoding: 'hex' | 'base64'): Buffer | undefined {
  if (encoding === 'hex' && !/^(?:[0-9a-fA-F]{2})+$/.test(text)) {
    return undefined;
  }
  if (encoding === 'base64' && !/^[A-Za-z0-9+/_-]+=*$/.test(text)) {
    return undefined;
  }
  return Buffer.from(text, encoding);
}

/** Constant-time equality that also hides the expected length. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  const ha = createHmac('sha256', 'oa-compare').update(a).digest();
  const hb = createHmac('sha256', 'oa-compare').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
