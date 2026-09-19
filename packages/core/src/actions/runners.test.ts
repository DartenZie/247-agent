import { describe, expect, it } from 'vitest';

import type { EventRecord, JsonValue } from '../store/types.js';
import { ConnectorAction, runConnector } from './connector.js';
import { runSequence, SequenceAction } from './sequence.js';
import { testContext } from './testing.js';
import { NonRetryableError, type ConnectorClients, type WaitSpec } from './types.js';
import { runWait, WaitAction, WaitTimeoutError } from './wait.js';

const event: EventRecord = {
  seq: 1,
  id: 'evt_1',
  type: 'orchestra.change_ready',
  source: 'task:update',
  ts: 'now',
  correlation_id: 'cor_1',
  parent_id: null,
  dedup_key: null,
  depth: 1,
  payload: { summary: 'new concert', diff: '+1' },
};

function fakeConnectors(): ConnectorClients & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    names: () => ['chat'],
    call: (connector, op, args) => {
      calls.push({ connector, op, args });
      return Promise.resolve({ ok: true, op } as JsonValue);
    },
  };
}

describe('runConnector', () => {
  it('renders args and calls the op', async () => {
    const connectors = fakeConnectors();
    const ctx = testContext({
      connectors,
      scope: { event: { payload: event.payload, correlation_id: 'cor_1' } },
    });
    await expect(
      runConnector(
        {
          kind: 'connector',
          connector: 'chat',
          op: 'ask',
          args: {
            text: 'Ready: ${event.payload.summary}',
            cid: '${event.correlation_id}',
            raw: '${event.payload}',
          },
          timeout: '5s',
        },
        ctx,
      ),
    ).resolves.toEqual({ ok: true, op: 'ask' });
    expect(connectors.calls).toEqual([
      {
        connector: 'chat',
        op: 'ask',
        args: { text: 'Ready: new concert', cid: 'cor_1', raw: event.payload },
      },
    ]);
  });

  it('fails without retry for an unknown connector or no supervisor', async () => {
    const action = { kind: 'connector', connector: 'email', op: 'x' };
    await expect(
      runConnector(action, testContext({ connectors: fakeConnectors() })),
    ).rejects.toThrow(NonRetryableError);
    await expect(runConnector(action, testContext())).rejects.toThrow(/no connector supervisor/);
    expect(
      ConnectorAction.safeParse({ kind: 'connector', connector: 'Bad', op: 'x' }).success,
    ).toBe(false);
    expect(ConnectorAction.parse({ kind: 'connector', connector: 'ok', op: 'x' }).args).toEqual({});
  });
});

describe('runWait', () => {
  it('suspends with the rendered filter and timeout', async () => {
    let spec: WaitSpec | undefined;
    let resumeData: JsonValue | undefined;
    const ctx = testContext({
      scope: { event: { correlation_id: 'cor_1' } },
      suspend: (s, r) => {
        spec = s;
        resumeData = r;
        return Promise.reject(new Error('suspended'));
      },
    });
    await expect(
      runWait(
        {
          kind: 'wait',
          for: {
            type: 'chat.reply',
            filter: "payload.correlation_id == '${event.correlation_id}'",
          },
          timeout: '2m',
        },
        ctx,
      ),
    ).rejects.toThrow('suspended');
    expect(spec).toEqual({
      type: 'chat.reply',
      filter: "payload.correlation_id == 'cor_1'",
      timeoutMs: 120_000,
      on_timeout: 'fail',
    });
    expect(resumeData).toEqual({ step: 0, steps: [] });
  });

  it('turns a resume into the matched event, a failure or a lenient result', async () => {
    const matched = testContext({ resume: { resume: null, outcome: 'matched', event } });
    const { seq: _seq, ...view } = event;
    await expect(runWait({ kind: 'wait', for: { type: 'chat.reply' } }, matched)).resolves.toEqual(
      view,
    );
    const timedOut = testContext({ resume: { resume: null, outcome: 'timeout' } });
    await expect(runWait({ kind: 'wait', for: { type: 'chat.reply' } }, timedOut)).rejects.toThrow(
      WaitTimeoutError,
    );
    await expect(
      runWait({ kind: 'wait', for: { type: 'chat.reply' }, on_timeout: 'succeed' }, timedOut),
    ).resolves.toEqual({ timed_out: true });
  });

  it('validates the type pattern and the filter template', () => {
    expect(WaitAction.safeParse({ kind: 'wait', for: { type: 'Bad Type' } }).success).toBe(false);
    expect(
      WaitAction.safeParse({ kind: 'wait', for: { type: 'a.b', filter: '${ x[ }' } }).success,
    ).toBe(false);
    expect(WaitAction.parse({ kind: 'wait', for: { type: 'a.*' } }).on_timeout).toBe('fail');
  });
});

describe('runSequence', () => {
  it('runs steps in order, exposes earlier results as steps[i] and skips on a falsy when', async () => {
    const connectors = fakeConnectors();
    const result = await runSequence(
      {
        kind: 'sequence',
        steps: [
          { kind: 'shell', cmd: ['echo', 'a'] },
          { kind: 'shell', when: "steps[0] == 'a'", cmd: ['echo', 'b ${steps[0]}'] },
          { kind: 'shell', when: "steps[0] == 'z'", cmd: ['echo', 'never'] },
          {
            kind: 'connector',
            connector: 'chat',
            op: 'send',
            args: { text: '${steps[1]} / ${steps[2]}' },
          },
        ],
      },
      testContext({ connectors }),
    );
    expect(result).toEqual({ steps: ['a', 'b a', null, { ok: true, op: 'send' }] });
    expect(connectors.calls[0]).toMatchObject({ args: { text: 'b a / ' } });
  });

  it('suspends at a wait step with its own checkpoint and continues from it on resume', async () => {
    let suspended: { spec: WaitSpec; resume: JsonValue } | undefined;
    const action = {
      kind: 'sequence',
      steps: [
        { kind: 'shell', cmd: ['echo', 'asked'] },
        { kind: 'wait', for: { type: 'chat.reply' } },
        { kind: 'shell', cmd: ['echo', 'got ${steps[1].payload.summary}'] },
      ],
    };
    await expect(
      runSequence(
        action,
        testContext({
          suspend: (spec, resume) => {
            suspended = { spec, resume };
            return Promise.reject(new Error('suspended'));
          },
        }),
      ),
    ).rejects.toThrow('suspended');
    expect(suspended).toEqual({
      spec: { type: 'chat.reply', filter: undefined, timeoutMs: undefined, on_timeout: 'fail' },
      resume: { step: 1, steps: ['asked'] },
    });

    const resumed = await runSequence(
      action,
      testContext({ resume: { resume: { step: 1, steps: ['asked'] }, outcome: 'matched', event } }),
    );
    expect(resumed).toEqual({
      steps: ['asked', expect.objectContaining({ id: 'evt_1' }), 'got new concert'],
    });

    await expect(
      runSequence(
        action,
        testContext({ resume: { resume: 'garbage', outcome: 'matched', event } }),
      ),
    ).rejects.toThrow(/corrupt/);
  });

  it('validates step kinds and when expressions', () => {
    expect(SequenceAction.safeParse({ kind: 'sequence', steps: [] }).success).toBe(false);
    expect(SequenceAction.safeParse({ kind: 'sequence', steps: [{ kind: 'llm' }] }).success).toBe(
      false,
    );
    expect(
      SequenceAction.safeParse({
        kind: 'sequence',
        steps: [{ kind: 'shell', cmd: ['x'], when: 'steps[' }],
      }).success,
    ).toBe(false);
  });
});
