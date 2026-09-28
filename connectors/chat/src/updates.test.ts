import { describe, expect, it } from 'vitest';

import { callbackUpdate, message, messageUpdate } from './test-helpers.js';
import {
  classifyUpdate,
  decodeCallback,
  encodeCallback,
  fromOf,
  inlineKeyboard,
  matchOption,
} from './updates.js';

describe('classifyUpdate', () => {
  it('turns a text message into a message with an ISO date and a from object', () => {
    const u = messageUpdate('hello', { chat_id: 42, message_id: 9 });
    expect(classifyUpdate(u)).toEqual({
      kind: 'message',
      chat_id: '42',
      message_id: 9,
      text: 'hello',
      from: { id: 7, name: 'Miro P', username: 'miro' },
      date: '2023-11-14T22:13:20.000Z',
      reply_to: null,
    });
  });

  it('uses the caption of a media message and records what it replies to', () => {
    const u = messageUpdate('', { message_id: 10, reply_to: 3 });
    delete u.message?.text;
    (u.message as { caption?: string }).caption = 'a photo';
    expect(classifyUpdate(u)).toMatchObject({ kind: 'message', text: 'a photo', reply_to: 3 });
  });

  it('turns a button tap into a callback', () => {
    expect(classifyUpdate(callbackUpdate('oa:abcd:1', { message_id: 5, query_id: 'q9' }))).toEqual({
      kind: 'callback',
      chat_id: '42',
      message_id: 5,
      query_id: 'q9',
      data: 'oa:abcd:1',
      from: { id: 7, name: 'Miro', username: 'miro' },
    });
  });

  it('ignores what it cannot use', () => {
    const noText = messageUpdate('x');
    delete noText.message?.text;
    expect(classifyUpdate(noText)).toMatchObject({ kind: 'ignored' });
    expect(classifyUpdate({ update_id: 1, edited_message: message('x') })).toEqual({
      kind: 'ignored',
      reason: 'edited message',
    });
    expect(classifyUpdate({ update_id: 2 })).toMatchObject({ kind: 'ignored' });
    const stale = callbackUpdate('oa:a:0', { message_id: 1 });
    delete stale.callback_query?.message;
    expect(classifyUpdate(stale)).toMatchObject({ kind: 'ignored', reason: /reachable/ });
  });

  it('describes anonymous senders', () => {
    expect(fromOf(undefined)).toEqual({ id: null, name: '', username: null });
    expect(fromOf({ id: 1, first_name: 'A' })).toEqual({ id: 1, name: 'A', username: null });
  });
});

describe('callback data', () => {
  it('round-trips and rejects foreign data', () => {
    expect(decodeCallback(encodeCallback('deadbeef', 2))).toEqual({ nonce: 'deadbeef', index: 2 });
    expect(encodeCallback('deadbeef', 2).length).toBeLessThanOrEqual(64);
    expect(decodeCallback('something else')).toBeUndefined();
    expect(decodeCallback('oa::1')).toBeUndefined();
    expect(decodeCallback('oa:x:-1')).toBeUndefined();
    expect(decodeCallback('oa:x:1.5')).toBeUndefined();
  });

  it('lays out up to three options in one row, more one per row', () => {
    expect(inlineKeyboard(['Approve', 'Reject'], 'n')).toEqual([
      [
        { text: 'Approve', callback_data: 'oa:n:0' },
        { text: 'Reject', callback_data: 'oa:n:1' },
      ],
    ]);
    expect(inlineKeyboard(['a', 'b', 'c', 'd'], 'n')).toHaveLength(4);
  });

  it('matches typed answers to options loosely', () => {
    expect(matchOption(' approve ', ['Approve', 'Reject'])).toBe('Approve');
    expect(matchOption('REJECT', ['Approve', 'Reject'])).toBe('Reject');
    expect(matchOption('why?', ['Approve', 'Reject'])).toBeUndefined();
    expect(matchOption('', ['Approve'])).toBeUndefined();
  });
});
