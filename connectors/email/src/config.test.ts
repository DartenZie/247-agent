import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';

describe('parseConfig', () => {
  it('fills ports and TLS from the protocol', () => {
    const c = parseConfig({
      incoming: { host: 'imap.example.com' },
      outgoing: { host: 'smtp.example.com', from: 'a@example.com' },
    });
    expect(c.incoming).toMatchObject({
      protocol: 'imap',
      port: 993,
      secure: true,
      folder: 'INBOX',
    });
    expect(c.outgoing).toMatchObject({ port: 465, secure: true });
  });

  it('treats a plain port as STARTTLS unless told otherwise', () => {
    const c = parseConfig({
      incoming: { protocol: 'pop3', host: 'h', port: 110 },
      outgoing: { host: 'h', port: 587, from: 'a@b', starttls: false },
    });
    expect(c.incoming).toMatchObject({ port: 110, secure: false, starttls: true });
    expect(c.outgoing).toMatchObject({ port: 587, secure: false, starttls: false });
    expect(parseConfig({ incoming: { host: 'h', secure: false } }).incoming?.port).toBe(143);
    expect(
      parseConfig({ incoming: { host: 'h', protocol: 'pop3', secure: false } }).incoming?.port,
    ).toBe(110);
  });

  it('inherits top-level credentials and lets each side override them', () => {
    const c = parseConfig({
      user: 'shared',
      password: 'pw',
      incoming: { host: 'h' },
      outgoing: { host: 'h', from: 'a@b', user: 'other' },
    });
    expect(c.incoming).toMatchObject({ user: 'shared', password: 'pw' });
    expect(c.outgoing).toMatchObject({ user: 'other', password: 'pw' });
  });

  it('allows send-only and receive-only configs but not an empty one', () => {
    expect(parseConfig({ outgoing: { host: 'h', from: 'a@b' } }).incoming).toBeUndefined();
    expect(parseConfig({ incoming: { host: 'h' } }).outgoing).toBeUndefined();
    expect(() => parseConfig({})).toThrow(/needs "incoming"/);
  });

  it('reports every problem with its path', () => {
    let message = '';
    try {
      parseConfig({ incoming: { protocol: 'nntp', port: 0 }, outgoing: {} });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^invalid email connector config:/);
    for (const path of [
      'incoming.protocol',
      'incoming.port',
      'incoming.host',
      'outgoing.host',
      'outgoing.from',
    ]) {
      expect(message).toContain(`\n  ${path}: `);
    }
  });
});
