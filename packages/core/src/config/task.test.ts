import { describe, expect, it } from 'vitest';

import { issuesFromZod } from './load.js';
import { EmitRule, Retry, Task } from './schema.js';

const base = {
  name: 'a',
  trigger: { kind: 'manual' },
  action: { kind: 'shell', cmd: ['echo', '${event.payload}'] },
};

function issues(task: unknown): string[] {
  const r = Task.safeParse(task);
  return r.success ? [] : issuesFromZod(r.error).map((i) => `${i.path}: ${i.message}`);
}

describe('Task schema: emit, retry, state_updates and templates', () => {
  it('accepts the documented routing shapes', () => {
    expect(
      issues({
        ...base,
        action: { kind: 'shell', cmd: ['x'], env: { P: '${secrets.ftp_pass}' } },
        retry: { attempts: 3 },
        emit: [
          {
            type: 'email.received',
            each: '${result.emails}',
            dedup_key: 'email:${item.id}',
            payload: '${item}',
          },
          { type: 'x.y', when: "result.kind != 'ignore'", payload: { k: '${result.kind}' } },
        ],
        state_updates: { 'email.last_uid': '${result.last_uid}', 'email.meta-1': { a: 1 } },
      }),
    ).toEqual([]);
    expect(Retry.parse({})).toEqual({
      attempts: 1,
      backoff: 'exponential',
      base: '30s',
      max: '1h',
    });
    expect(Task.parse({ ...base, retry: { attempts: 2, base: '1m' } }).retry).toMatchObject({
      attempts: 2,
      base: '1m',
      max: '1h',
    });
  });

  it('rejects bad emit rules', () => {
    const badType = EmitRule.safeParse({ type: 'task.*.x' });
    expect(!badType.success && issuesFromZod(badType.error)[0]?.path).toBe('type');
    expect(issues({ ...base, emit: [{ type: 'x.y', when: 'result[' }] })).toEqual([
      expect.stringMatching(/^emit\[0\]\.when: invalid JMESPath/),
    ]);
    expect(issues({ ...base, emit: [{ type: 'x.y', each: 'items: ${result.items}' }] })).toEqual([
      expect.stringMatching(/^emit\[0\]\.each: each must be a single/),
    ]);
    expect(
      issues({ ...base, emit: [{ type: 'x.y', payload: { p: '${secrets.ftp_pass}' } }] }),
    ).toEqual([expect.stringMatching(/^emit\[0\]: secrets cannot be used here/)]);
    expect(issues({ ...base, emit: [{ type: 'x.y', payload: '${ event[ }' }] })).toEqual([
      expect.stringMatching(/^emit\[0\]: invalid JMESPath/),
    ]);
  });

  it('rejects bad state_updates keys and secrets in values', () => {
    expect(issues({ ...base, state_updates: { last_uid: 1 } })).toEqual([
      expect.stringMatching(/^state_updates\.last_uid: state keys are/),
    ]);
    expect(issues({ ...base, state_updates: { 'a.b': '${secrets.x}' } })).toEqual([
      expect.stringMatching(/^state_updates: secrets cannot be used here/),
    ]);
  });

  it('checks templates inside the action and refuses whole-object secrets', () => {
    expect(issues({ ...base, action: { kind: 'shell', cmd: ['${ event[ }'] } })).toEqual([
      expect.stringMatching(/^action: invalid JMESPath/),
    ]);
    expect(issues({ ...base, action: { kind: 'shell', cmd: ['x'], stdin: '${secrets}' } })).toEqual(
      [expect.stringMatching(/^action: reference secrets by name/)],
    );
    expect(issues({ ...base, retry: { attempts: 0 } })).toEqual([
      expect.stringMatching(/^retry\.attempts/),
    ]);
  });

  it('validates connector, wait and sequence actions through the task', () => {
    expect(
      issues({
        ...base,
        action: {
          kind: 'sequence',
          steps: [
            {
              kind: 'connector',
              connector: 'chat',
              op: 'ask',
              args: { text: '${event.payload.summary}' },
            },
            {
              kind: 'wait',
              for: { type: 'chat.reply', filter: "payload.cid == '${event.correlation_id}'" },
              timeout: '24h',
            },
            { kind: 'shell', when: 'steps[1].payload.approved == `true`', cmd: ['git', 'push'] },
          ],
        },
      }),
    ).toEqual([]);
    expect(issues({ ...base, action: { kind: 'wait', for: { type: 'chat reply' } } })).toEqual([
      expect.stringMatching(/^action\.for\.type/),
    ]);
  });
});
