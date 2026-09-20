import { describe, expect, it } from 'vitest';

import { htmlToText, parseMessage } from './parse.js';

const raw = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n') + '\r\n');

describe('parseMessage', () => {
  it('maps headers and the text body', async () => {
    const m = await parseMessage(
      raw([
        'From: Conductor <Orchestrator@Example.cz>',
        'To: info@example.cz, Second <b@example.cz>',
        'Cc: c@example.cz',
        'Reply-To: replies@example.cz',
        'Subject: Spring concert',
        'Date: Mon, 01 Jun 2026 10:00:00 +0200',
        'Message-ID: <m1@example.cz>',
        'In-Reply-To: <m0@example.cz>',
        'References: <m-1@example.cz> <m0@example.cz>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please add it.',
      ]),
      { uid: 7, maxBodyChars: 1000 },
    );
    expect(m).toMatchObject({
      uid: 7,
      message_id: '<m1@example.cz>',
      from: 'orchestrator@example.cz',
      from_name: 'Conductor',
      to: ['info@example.cz', 'b@example.cz'],
      cc: ['c@example.cz'],
      reply_to: 'replies@example.cz',
      subject: 'Spring concert',
      date: '2026-06-01T08:00:00.000Z',
      body: 'Please add it.',
      truncated: false,
      in_reply_to: '<m0@example.cz>',
      references: ['<m-1@example.cz>', '<m0@example.cz>'],
      attachments: [],
    });
  });

  it('renders HTML-only mail as text and lists attachments without content', async () => {
    const m = await parseMessage(
      raw([
        'From: a@example.cz',
        'Subject: html',
        'Message-ID: <h@example.cz>',
        'Content-Type: multipart/mixed; boundary=B',
        '',
        '--B',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><p>Hello &amp; <b>welcome</b></p><p>Bye</p></body></html>',
        '--B',
        'Content-Type: application/pdf; name=programme.pdf',
        'Content-Disposition: attachment; filename=programme.pdf',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQK',
        '--B--',
      ]),
      { uid: 'p1', maxBodyChars: 1000 },
    );
    expect(m.body).toBe('Hello & welcome\nBye');
    expect(m.attachments).toEqual([
      { filename: 'programme.pdf', content_type: 'application/pdf', size: 9 },
    ]);
    expect(m.to).toEqual([]);
    expect(m.reply_to).toBeNull();
  });

  it('truncates long bodies and synthesises a Message-ID when missing', async () => {
    const source = raw(['From: a@example.cz', 'Subject: long', '', 'x'.repeat(50)]);
    const m = await parseMessage(source, { uid: 1, maxBodyChars: 10 });
    expect(m.body).toBe('x'.repeat(10));
    expect(m.truncated).toBe(true);
    expect(m.message_id).toMatch(/^<sha256-[0-9a-f]{32}@missing-message-id>$/);
    const again = await parseMessage(source, { uid: 2, maxBodyChars: 10 });
    expect(again.message_id).toBe(m.message_id);
  });
});

describe('htmlToText', () => {
  it('drops tags, scripts and styles and keeps line structure', () => {
    expect(
      htmlToText('<style>p{}</style><div>One<br>Two</div><script>x()</script><p>Three &lt;3</p>'),
    ).toBe('One\nTwo\nThree <3');
  });
});
