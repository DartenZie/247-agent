import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';

import {
  appendHtmlFooter,
  appendTextFooter,
  buildMessage,
  sendMail,
  textFooterAsHtml,
} from './send.js';
import { outgoingConfig as outgoing } from './test-helpers.js';

describe('footer', () => {
  it('appends the text footer after one blank line', () => {
    expect(appendTextFooter('Hello\n\n', '-- \nOrchestra\n')).toBe('Hello\n\n-- \nOrchestra\n');
    expect(appendTextFooter('Hello', undefined)).toBe('Hello');
    expect(appendTextFooter('Hello', '  \n')).toBe('Hello');
  });

  it('puts the HTML footer before </body> when there is one', () => {
    expect(appendHtmlFooter('<html><body><p>Hi</p></body></html>', '<p>F</p>')).toBe(
      '<html><body><p>Hi</p><p>F</p></body></html>',
    );
    expect(appendHtmlFooter('<p>Hi</p>', '<p>F</p>')).toBe('<p>Hi</p><p>F</p>');
    expect(appendHtmlFooter('<p>Hi</p>', undefined)).toBe('<p>Hi</p>');
  });

  it('derives an escaped HTML footer from the text one', () => {
    expect(textFooterAsHtml('Orchestra <info@example.cz>\n"Music & more"\n')).toBe(
      '<p class="footer">Orchestra &lt;info@example.cz&gt;<br>\n&quot;Music &amp; more&quot;</p>',
    );
  });
});

describe('buildMessage', () => {
  it('adds the footer to text and html and threads replies', () => {
    const msg = buildMessage(outgoing({ footer: 'Sent by 247-agent' }), {
      to: 'a@example.cz',
      cc: ['b@example.cz'],
      subject: 'Re: Spring concert',
      text: 'Done.',
      html: '<p>Done.</p>',
      in_reply_to: '<m1@example.cz>',
      references: ['<m0@example.cz>'],
    });
    expect(msg).toMatchObject({
      from: 'Orchestra <info@example.cz>',
      to: 'a@example.cz',
      cc: ['b@example.cz'],
      subject: 'Re: Spring concert',
      text: 'Done.\n\nSent by 247-agent\n',
      html: '<p>Done.</p><p class="footer">Sent by 247-agent</p>',
      inReplyTo: '<m1@example.cz>',
      references: ['<m0@example.cz>', '<m1@example.cz>'],
    });
  });

  it('prefers footer_html for the html part and leaves mail alone without a footer', () => {
    const withHtml = buildMessage(outgoing({ footer: 'T', footer_html: '<i>H</i>' }), {
      to: 'a@b',
      subject: 's',
      text: 'x',
      html: 'y',
    });
    expect(withHtml.text).toBe('x\n\nT\n');
    expect(withHtml.html).toBe('y<i>H</i>');
    const plain = buildMessage(outgoing(), { to: 'a@b', subject: 's', text: 'x' });
    expect(plain.text).toBe('x');
    expect(plain).not.toHaveProperty('html');
  });

  it('decodes attachments and rejects an empty body', () => {
    const msg = buildMessage(outgoing(), {
      to: 'a@b',
      subject: 's',
      text: 'x',
      attachments: [
        {
          filename: 'a.bin',
          content: Buffer.from('hi').toString('base64'),
          encoding: 'base64',
          content_type: 'application/octet-stream',
        },
      ],
    });
    expect(msg.attachments).toEqual([
      { filename: 'a.bin', content: Buffer.from('hi'), contentType: 'application/octet-stream' },
    ]);
    expect(() => buildMessage(outgoing(), { to: 'a@b', subject: 's' })).toThrow(
      /text, html or both/,
    );
  });
});

describe('sendMail', () => {
  it('produces a message with the footer through a nodemailer transport', async () => {
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    const msg = buildMessage(outgoing({ footer: '-- \nOrchestra office' }), {
      to: 'a@example.cz',
      subject: 'Hello',
      text: 'Body',
    });
    const result = await sendMail(transport, msg);
    expect(result.message_id).toMatch(/^<.+@example\.cz>$/);
    const info = (await transport.sendMail(msg)) as unknown as { message: Buffer };
    const text = info.message.toString('utf8');
    expect(text).toContain('From: Orchestra <info@example.cz>');
    expect(text).toContain('Body\n\n-- \nOrchestra office\n');
  });

  it('maps the SMTP accepted/rejected lists to bare addresses', async () => {
    const transport = {
      sendMail: () =>
        Promise.resolve({
          messageId: '<x@example.cz>',
          accepted: ['a@example.cz', { address: 'b@example.cz' }],
          rejected: [{ address: 'c@example.cz' }],
        }),
    } as unknown as Parameters<typeof sendMail>[0];
    expect(await sendMail(transport, { to: 'a@example.cz' })).toEqual({
      message_id: '<x@example.cz>',
      accepted: ['a@example.cz', 'b@example.cz'],
      rejected: ['c@example.cz'],
    });
  });
});
