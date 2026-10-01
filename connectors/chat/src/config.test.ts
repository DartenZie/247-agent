import { describe, expect, it } from 'vitest';

import { allowedChats, parseConfig } from './config.js';

describe('parseConfig', () => {
  it('fills defaults', () => {
    const c = parseConfig({ token: 't', chat_id: 42 });
    expect(c).toEqual({
      backend: 'telegram',
      token: 't',
      chat_id: '42',
      allowed_chat_ids: [],
      poll_timeout: 30,
      initial: 'none',
      ask_options: ['Approve', 'Reject'],
      pending_limit: 200,
      api_base: 'https://api.telegram.org',
      timeout: 30_000,
    });
  });

  it('normalises chat ids to strings and accepts groups and channels', () => {
    expect(parseConfig({ token: 't', chat_id: -1001234 }).chat_id).toBe('-1001234');
    expect(parseConfig({ token: 't', chat_id: ' 42\n' }).chat_id).toBe('42');
    expect(parseConfig({ token: 't', chat_id: '@ops_channel' }).chat_id).toBe('@ops_channel');
    expect(() => parseConfig({ token: 't', chat_id: 'abc' })).toThrow(/chat_id: must be/);
  });

  it('collects the allowed chats', () => {
    const c = parseConfig({ token: 't', chat_id: 1, allowed_chat_ids: [2, '3', 1] });
    expect([...allowedChats(c)]).toEqual(['1', '2', '3']);
  });

  it('strips a trailing slash from api_base and trims the token', () => {
    const c = parseConfig({ token: ' t \n', chat_id: 1, api_base: 'http://localhost:8081/' });
    expect(c.backend === 'telegram' && c.api_base).toBe('http://localhost:8081');
    expect(c.token).toBe('t');
  });

  it('reports every problem with its path', () => {
    let message = '';
    try {
      parseConfig({ poll_timeout: 99, ask_options: [] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^invalid chat connector config:/);
    for (const path of ['token', 'chat_id', 'poll_timeout', 'ask_options']) {
      expect(message).toContain(`\n  ${path}: `);
    }
  });

  it('rejects unknown backends', () => {
    expect(() => parseConfig({ backend: 'irc', token: 't', chat_id: 1 })).toThrow(/backend/);
  });
});

describe('parseConfig, matrix', () => {
  const base = { backend: 'matrix', homeserver: 'https://matrix.example.org/', token: 'syt_x' };

  it('fills defaults and accepts room ids and aliases', () => {
    const c = parseConfig({
      ...base,
      chat_id: '!abc:example.org',
      allowed_chat_ids: ['#ops:example.org'],
    });
    expect(c).toEqual({
      backend: 'matrix',
      homeserver: 'https://matrix.example.org',
      token: 'syt_x',
      chat_id: '!abc:example.org',
      allowed_chat_ids: ['#ops:example.org'],
      poll_timeout: 30,
      initial: 'none',
      ask_options: ['Approve', 'Reject'],
      pending_limit: 200,
      timeout: 30_000,
    });
  });

  it('refuses Telegram-style ids, more than 10 options and a missing homeserver', () => {
    expect(() => parseConfig({ ...base, chat_id: 42 })).toThrow(/chat_id: /);
    expect(() => parseConfig({ ...base, chat_id: 'ops' })).toThrow(/room id/);
    expect(() =>
      parseConfig({
        ...base,
        chat_id: '!a:b',
        ask_options: Array.from({ length: 11 }, (_, i) => String(i)),
      }),
    ).toThrow(/ask_options/);
    expect(() => parseConfig({ backend: 'matrix', token: 't', chat_id: '!a:b' })).toThrow(
      /homeserver/,
    );
  });
});
