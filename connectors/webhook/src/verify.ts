/**
 * Request authentication per route: an HMAC of the raw body (GitHub and any service that
 * signs the same way), an HMAC of a timestamp plus the body (Slack, Stripe, a configured
 * layout) with a replay window, or a shared token in a header (GitLab, a bearer token).
 * Every comparison is constant-time and nothing about the expected value leaks into the
 * error.
 *
 * `checkHeaders` runs before the body is read and rejects what the headers alone settle:
 * a token check completely, and for a signature a missing or malformed header or a
 * timestamp outside the window. `verifyRequest` then runs the full check on the body.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { VerifyConfig } from './config.js';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** An HMAC check with its inputs taken from the headers, ready to run over the body. */
interface HmacPlan {
  secret: string;
  algorithm: string;
  /** Candidate signatures; any one matching passes (Stripe sends one per active secret). */
  signatures: Buffer[];
  /** The bytes signed before and after the body. */
  before: string;
  after: string;
}

type Planned = { ok: false; reason: string } | { ok: true; plan: HmacPlan | undefined };

/** What the headers alone settle; `ok` means the body still has to pass `verifyRequest`. */
export function checkHeaders(
  verify: VerifyConfig,
  headers: IncomingHttpHeaders,
  now: Date = new Date(),
): VerifyResult {
  const planned = plan(verify, headers, now);
  return planned.ok ? { ok: true } : planned;
}

/** Checks one request against its route's `verify`; `body` is the raw bytes as received. */
export function verifyRequest(
  verify: VerifyConfig,
  headers: IncomingHttpHeaders,
  body: Buffer,
  now: Date = new Date(),
): VerifyResult {
  const planned = plan(verify, headers, now);
  if (!planned.ok || planned.plan === undefined) {
    return planned.ok ? { ok: true } : planned;
  }
  const p = planned.plan;
  const expected = createHmac(p.algorithm, p.secret)
    .update(p.before)
    .update(body)
    .update(p.after)
    .digest();
  let match = false;
  for (const given of p.signatures) {
    match = safeEqual(given, expected) || match;
  }
  return match ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

function plan(verify: VerifyConfig, headers: IncomingHttpHeaders, now: Date): Planned {
  switch (verify.kind) {
    case 'none':
      return { ok: true, plan: undefined };
    case 'gitlab':
      return settled(
        checkToken(headers, { token: verify.token, header: 'x-gitlab-token', scheme: '' }),
      );
    case 'token':
      return settled(checkToken(headers, verify));
    case 'github':
      return headerHmac(headers, now, {
        secret: verify.secret,
        header: 'x-hub-signature-256',
        algorithm: 'sha256',
        encoding: 'hex',
        prefix: 'sha256=',
      });
    case 'slack':
      return headerHmac(headers, now, {
        secret: verify.secret,
        header: 'x-slack-signature',
        algorithm: 'sha256',
        encoding: 'hex',
        prefix: 'v0=',
        timestamp: {
          header: 'x-slack-request-timestamp',
          signed: 'v0:{timestamp}:{body}',
          tolerance: verify.tolerance,
        },
      });
    case 'hmac':
      return headerHmac(headers, now, verify);
    case 'stripe':
      return stripe(headers, now, verify.secret, verify.tolerance);
  }
}

function settled(result: VerifyResult): Planned {
  return result.ok ? { ok: true, plan: undefined } : result;
}

/** A signature in one header, optionally over a timestamp from another. */
function headerHmac(
  headers: IncomingHttpHeaders,
  now: Date,
  opts: {
    secret: string;
    header: string;
    algorithm: string;
    encoding: 'hex' | 'base64';
    prefix: string;
    timestamp?: { header: string; signed: string; tolerance: number } | undefined;
  },
): Planned {
  const value = single(headers[opts.header]);
  if (value === undefined) {
    return { ok: false, reason: `missing ${opts.header}` };
  }
  if (!value.startsWith(opts.prefix)) {
    return { ok: false, reason: `${opts.header} does not start with "${opts.prefix}"` };
  }
  const given = decode(value.slice(opts.prefix.length).trim(), opts.encoding);
  if (given === undefined) {
    return { ok: false, reason: 'signature mismatch' };
  }
  let before = '';
  let after = '';
  if (opts.timestamp !== undefined) {
    const ts = single(headers[opts.timestamp.header]);
    if (ts === undefined) {
      return { ok: false, reason: `missing ${opts.timestamp.header}` };
    }
    const fresh = checkTime(ts.trim(), opts.timestamp.header, opts.timestamp.tolerance, now);
    if (!fresh.ok) {
      return fresh;
    }
    [before, after] = layout(opts.timestamp.signed, ts.trim());
  }
  return {
    ok: true,
    plan: { secret: opts.secret, algorithm: opts.algorithm, signatures: [given], before, after },
  };
}

/** `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`, signed as `<t>.<body>`. */
function stripe(
  headers: IncomingHttpHeaders,
  now: Date,
  secret: string,
  tolerance: number,
): Planned {
  const header = 'stripe-signature';
  const value = single(headers[header]);
  if (value === undefined) {
    return { ok: false, reason: `missing ${header}` };
  }
  let ts: string | undefined;
  const signatures: Buffer[] = [];
  let v1 = 0;
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (eq < 0) {
      continue;
    }
    if (key === 't') {
      ts = val;
    } else if (key === 'v1') {
      v1 += 1;
      const sig = decode(val, 'hex');
      if (sig !== undefined) {
        signatures.push(sig);
      }
    }
  }
  if (ts === undefined) {
    return { ok: false, reason: `${header} has no t=` };
  }
  if (v1 === 0) {
    return { ok: false, reason: `${header} has no v1=` };
  }
  const fresh = checkTime(ts, `${header} t=`, tolerance, now);
  if (!fresh.ok) {
    return fresh;
  }
  if (signatures.length === 0) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return {
    ok: true,
    plan: { secret, algorithm: 'sha256', signatures, before: `${ts}.`, after: '' },
  };
}

function checkTime(text: string, what: string, tolerance: number, now: Date): VerifyResult {
  if (!/^\d{1,12}$/.test(text)) {
    return { ok: false, reason: `${what} is not a Unix time in seconds` };
  }
  if (Math.abs(now.getTime() / 1000 - Number(text)) > tolerance) {
    return { ok: false, reason: `timestamp outside the ${String(tolerance)} s window` };
  }
  return { ok: true };
}

/** Splits a `signed` layout around `{body}`, with the timestamp filled in. */
function layout(signed: string, ts: string): [string, string] {
  const [before = '', after = ''] = signed.split('{body}');
  return [before.replace('{timestamp}', ts), after.replace('{timestamp}', ts)];
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
