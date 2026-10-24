import { describe, expect, it } from 'vitest';

import { parseAuthResults, senderAuth } from './auth.js';

const MX =
  ' mx.example.net;\r\n dkim=pass (2048-bit key) header.d=example.com header.s=s1;\r\n' +
  ' spf=pass smtp.mailfrom=example.com; dmarc=pass (p=REJECT) header.from=example.com';

describe('senderAuth', () => {
  it("reads the trusted server's DKIM, SPF and DMARC results", () => {
    expect(senderAuth([MX], ['mx.example.net'], 'editor@example.com')).toEqual({
      authserv_id: 'mx.example.net',
      dkim: 'pass',
      dkim_domains: ['example.com'],
      spf: 'pass',
      dmarc: 'pass',
    });
  });

  it('ignores headers from any other authserv-id, such as one the sender wrote', () => {
    const forged = 'mx.example.net.evil; dkim=pass header.d=example.com; dmarc=pass';
    expect(senderAuth([forged], ['mx.example.net'], 'editor@example.com')).toEqual({
      authserv_id: null,
      dkim: 'none',
      dkim_domains: [],
      spf: 'none',
      dmarc: 'none',
    });
    expect(senderAuth([MX], [], 'editor@example.com').dmarc).toBe('none');
  });

  it('uses only the topmost trusted header', () => {
    const real = 'MX.example.net; spf=softfail; dmarc=fail header.from=example.com';
    const below = 'mx.example.net; spf=pass; dmarc=pass header.from=example.com';
    expect(senderAuth([real, below], ['mx.example.net'], 'editor@example.com')).toMatchObject({
      spf: 'softfail',
      dmarc: 'fail',
    });
  });

  it('reports DMARC only for the domain of from', () => {
    expect(senderAuth([MX], ['mx.example.net'], 'editor@other.org').dmarc).toBe('none');
    expect(senderAuth([MX], ['mx.example.net'], '').dmarc).toBe('none');
    const noDomain = 'mx.example.net; dmarc=pass';
    expect(senderAuth([noDomain], ['mx.example.net'], 'a@b.org').dmarc).toBe('pass');
  });

  it('passes DKIM when any signature passes and lists only passing domains', () => {
    const h = 'mx; dkim=fail header.d=a.org; dkim=pass header.d=B.org; dkim=pass header.d=c.org';
    expect(senderAuth([h], ['mx'], 'x@b.org')).toMatchObject({
      dkim: 'pass',
      dkim_domains: ['b.org', 'c.org'],
    });
    expect(senderAuth(['mx; dkim=neutral; dkim=fail'], ['mx'], 'x@b.org').dkim).toBe('neutral');
  });
});

describe('parseAuthResults', () => {
  it('handles a version, nested comments, quoted values and `none`', () => {
    expect(parseAuthResults('mx 1; none')).toEqual({ authservId: 'mx', results: [] });
    const r = parseAuthResults(
      'mx (a (nested) comment); spf/1=PASS smtp.mailfrom="x;y@b.org"; auth=pass (x;) smtp.auth=u',
    );
    expect(r?.results.map((m) => [m.method, m.result, Object.fromEntries(m.props)])).toEqual([
      ['spf', 'pass', { 'smtp.mailfrom': 'x;y@b.org' }],
      ['auth', 'pass', { 'smtp.auth': 'u' }],
    ]);
    expect(parseAuthResults(' ; dkim=pass')).toBeNull();
  });
});
