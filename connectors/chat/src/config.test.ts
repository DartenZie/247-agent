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
    expect(c.api_base).toBe('http://localhost:8081');
    expect(c.token).toBe('t');
  });

  it('reports every problem with its path and rejects other backends', () => {
    let message = '';
    try {
      parseConfig({ backend: 'matrix', poll_timeout: 99, ask_options: [] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^invalid chat connector config:/);
    for (const path of ['backend', 'token', 'chat_id', 'poll_timeout', 'ask_options']) {
      expect(message).toContain(`\n  ${path}: `);
    }
  });
});
