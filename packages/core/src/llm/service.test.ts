import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isRetryable, NonRetryableError } from '../actions/types.js';
import { createBus, type EventBus } from '../bus/bus.js';
import { testEnv, type TestEnv } from '../bus/testing.js';
import { staticSecrets } from '../secrets/secrets.js';
import type { RunRecord } from '../store/types.js';
import type { ProviderConfigParsed } from './config.js';
import { BudgetExceededError, ProviderUnavailableError, UnpricedModelError } from './errors.js';
import { resolvePricing } from './pricing.js';
import { BUDGET_EXCEEDED, LlmService, type LlmServiceOptions } from './service.js';
import { fakeProviderFactory, type FakeProvider } from './testing.js';
import type { DecideCall, DecideResponse, LlmCall, LlmResponse } from './types.js';

let env: TestEnv;
let bus: EventBus;
let fake: FakeProvider;
let runs = 0;

const providers: Record<string, ProviderConfigParsed> = {
  anthropic: { type: 'anthropic', api_key: '${secrets.anthropic_key}', headers: {} },
  router: {
    type: 'openrouter',
    api_key: '${secrets.router_key}',
    headers: { 'X-Title': '${env.APP}', 'X-Secret': '${secrets.router_key}' },
  },
  nokey: { type: 'anthropic', api_key: '${secrets.missing}', headers: {} },
};

function service(over: Partial<LlmServiceOptions> = {}): LlmService {
  return new LlmService({
    store: env.store,
    bus,
    clock: env.clock,
    log: env.log,
    secrets: staticSecrets({ anthropic_key: 'sk-ant', router_key: 'sk-or' }),
    env: { APP: '247' },
    configDir: env.dir,
    providers,
    pricing: resolvePricing({}),
    defaults: { max_tokens: 1024 },
    budgets: {},
    factories: { anthropic: fake.factory, openrouter: fake.factory },
    ...over,
  });
}

/** A queued run the ledger rows can reference (foreign keys are on). */
function run(task = 'classify'): RunRecord {
  runs += 1;
  const id = `run_${String(runs)}`;
  const event = bus.publish({ type: 'x.y', source: 'test' });
  if (event.status !== 'inserted') {
    throw new Error('unreachable');
  }
  env.store.runs.insertQueued({
    id,
    task,
    event_id: event.event.id,
    correlation_id: event.event.correlation_id,
    created_at: env.clock.now().toISOString(),
  });
  const r = env.store.runs.getById(id);
  if (r === undefined) {
    throw new Error('unreachable');
  }
  return r;
}

const usage = (input: number, output: number): LlmResponse => ({
  output: { kind: 'x' },
  usage: { input, output, cacheRead: 0, cacheWrite: 0 },
  stopReason: 'end',
});

function call(
  s: LlmService,
  over: Partial<LlmCall> = {},
  r: RunRecord = run(),
): ReturnType<LlmService['call']> {
  return s.call(
    {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      input: 'classify this',
      maxTokens: 100,
      ...over,
    },
    { run: r, task: r.task, signal: new AbortController().signal, log: env.log },
  );
}

const events = (type: string) => env.store.events.listAfter(0, 100).filter((e) => e.type === type);

beforeEach(() => {
  env = testEnv();
  bus = createBus({ store: env.store, clock: env.clock, log: env.log });
  fake = fakeProviderFactory(usage(1000, 100)); // haiku: $0.001 + $0.0005
});

afterEach(() => {
  env.close();
});

describe('LlmService.call', () => {
  it('resolves the key per call, prices from the table, writes the ledger row and logs no secret', async () => {
    const s = service();
    const res = await call(s, { system: 'be brief', effort: 'low' });
    expect(res.usd).toBeCloseTo(0.0015);
    expect(res.priced_by).toBe('table');
    expect(res.output).toEqual({ kind: 'x' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.provider).toEqual({
      name: 'anthropic',
      type: 'anthropic',
      apiKey: 'sk-ant',
      baseUrl: undefined,
      headers: {},
    });
    expect(fake.requests[0]?.req).toMatchObject({
      model: 'claude-haiku-4-5',
      system: 'be brief',
      input: 'classify this',
      maxTokens: 100,
      effort: 'low',
    });
    const rows = env.store.ledger.listByRun('run_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task: 'classify',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      in_tok: 1000,
      out_tok: 100,
      usd: expect.closeTo(0.0015, 6) as number,
      priced_by: 'table',
      ts: '2026-09-19T10:00:00.000Z',
    });
    expect(JSON.stringify(rows) + JSON.stringify(env.lines)).not.toContain('sk-ant');
    expect(env.lines.find((l) => l.msg === 'llm.call')).toMatchObject({
      provider: 'anthropic',
      in_tok: 1000,
      out_tok: 100,
      stop_reason: 'end',
    });
  });

  it('renders provider headers from env and secrets', async () => {
    const s = service();
    await call(s, { provider: 'router' });
    expect(fake.requests[0]?.provider.headers).toEqual({ 'X-Title': '247', 'X-Secret': 'sk-or' });
  });

  it('fails non-retryably on an unknown provider, a missing adapter, an unpriced model or a missing secret', async () => {
    const s = service({ factories: { anthropic: fake.factory } });
    await expect(call(s, { provider: 'nope' })).rejects.toThrow(ProviderUnavailableError);
    await expect(call(s, { provider: 'router' })).rejects.toThrow(/no adapter in this build/);
    await expect(call(s, { model: 'claude-9' })).rejects.toThrow(UnpricedModelError);
    const missing = call(s, { provider: 'nokey' });
    await expect(missing).rejects.toThrow(NonRetryableError);
    await expect(missing).rejects.toThrow(/secret "missing" is not set/);
    expect(fake.requests).toHaveLength(0);
    for (const p of [call(s, { provider: 'nope' }), call(s, { model: 'claude-9' })]) {
      await p.catch((err: unknown) => {
        expect(isRetryable(err)).toBe(false);
      });
    }
  });

  it('refuses before the call when the worst case would exceed the run budget', async () => {
    const s = service();
    // 13 chars → 5 input tokens ($0.000005) + 100 output tokens ($0.0005) = worst case $0.000505.
    await expect(call(s, { maxUsd: 0.0005 })).rejects.toThrow(/worst case/);
    expect(fake.requests).toHaveLength(0);
    expect(env.store.ledger.sumSince('2000-01-01')).toBe(0);
    await expect(call(s, { maxUsd: 0.01 })).resolves.toMatchObject({ priced_by: 'table' });
  });

  it('fails the run when the actual cost overruns the budget, keeping the row', async () => {
    fake = fakeProviderFactory(usage(10_000, 100)); // $0.0105, the estimate was $0.0005
    const s = service();
    const r = run();
    await expect(call(s, { maxUsd: 0.005 }, r)).rejects.toThrow(BudgetExceededError);
    expect(env.store.ledger.sumForRun(r.id)).toBeCloseTo(0.0105);
    // A later call in the same run is refused before spending anything more.
    await expect(call(s, { maxUsd: 0.005 }, r)).rejects.toThrow(/already spent/);
    expect(fake.requests).toHaveLength(1);
  });

  it('trips the daily breaker once, refuses further calls and resets at UTC midnight', async () => {
    const s = service({ budgets: { daily_usd: 0.002 } });
    // First call is allowed (nothing spent yet) and crosses the cap: result returned, event emitted.
    await expect(call(s)).resolves.toMatchObject({ usd: expect.closeTo(0.0015, 6) as number });
    await expect(call(s)).resolves.toBeDefined();
    expect(events(BUDGET_EXCEEDED)).toHaveLength(1);
    expect(events(BUDGET_EXCEEDED)[0]).toMatchObject({
      source: 'core',
      dedup_key: 'budget:daily:2026-09-19',
      payload: { scope: 'daily', day: '2026-09-19', limit_usd: 0.002 },
    });
    // Now over the cap: refused without contacting the provider, no second event.
    await expect(call(s)).rejects.toThrow(/daily budget/);
    expect(fake.requests).toHaveLength(2);
    expect(events(BUDGET_EXCEEDED)).toHaveLength(1);
    expect(env.lines.filter((l) => l.msg === BUDGET_EXCEEDED)).toHaveLength(1);
    // The next UTC day starts fresh.
    env.clock.set('2026-09-20T00:00:00.000Z');
    await expect(call(s)).resolves.toBeDefined();
    expect(fake.requests).toHaveLength(3);
  });

  it('uses the cost an OpenRouter-type provider reports, and fails when it reports none', async () => {
    fake = fakeProviderFactory({
      ...usage(500, 50),
      usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.042 },
    });
    const s = service();
    const res = await call(s, { provider: 'router', model: 'vendor/some-model' });
    expect(res).toMatchObject({ usd: 0.042, priced_by: 'provider' });

    fake = fakeProviderFactory(usage(500, 50));
    const s2 = service();
    const r = run();
    await expect(call(s2, { provider: 'router', model: 'vendor/other' }, r)).rejects.toThrow(
      UnpricedModelError,
    );
    expect(env.store.ledger.listByRun(r.id)[0]).toMatchObject({ usd: 0, priced_by: 'unpriced' });
  });
});

describe('LlmService.decide', () => {
  const QUESTIONS: DecideCall['questions'] = {
    kind: { type: 'choice', instructions: 'What?', criteria: { a: 'A', b: 'B' } },
    urgent: { type: 'noul', instructions: 'Urgent?' },
  };
  const decision = (reportedUsd?: number): DecideResponse => ({
    answers: {
      kind: { type: 'choice', choice: 'a', confidence: 0.9 },
      urgent: { type: 'noul', noul: 0.2 },
    },
    usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, reportedUsd },
    id: 'gen-dec-1',
    provider: 'TypeSafe',
  });

  function decide(
    s: LlmService,
    over: Partial<DecideCall> = {},
    r: RunRecord = run('triage'),
  ): ReturnType<LlmService['decide']> {
    return s.decide(
      {
        provider: 'router',
        model: 'typesafe/jev-1.13',
        state: 'classify this',
        questions: QUESTIONS,
        ...over,
      },
      { run: r, task: r.task, signal: new AbortController().signal, log: env.log },
    );
  }

  it('calls the adapter, ledgers the reported cost and logs the question count, never the state', async () => {
    fake = fakeProviderFactory(usage(1, 1), decision(0.000042));
    const s = service();
    const r = run('triage');
    const res = await decide(s, {}, r);
    expect(res).toMatchObject({ usd: 0.000042, priced_by: 'provider', id: 'gen-dec-1' });
    expect(res.answers.kind).toEqual({ type: 'choice', choice: 'a', confidence: 0.9 });
    expect(fake.requests).toHaveLength(0);
    expect(fake.decides).toHaveLength(1);
    expect(fake.decides[0]?.provider).toMatchObject({ name: 'router', apiKey: 'sk-or' });
    expect(fake.decides[0]?.req).toMatchObject({
      model: 'typesafe/jev-1.13',
      state: 'classify this',
      questions: QUESTIONS,
    });
    expect(env.store.ledger.listByRun(r.id)[0]).toMatchObject({
      task: 'triage',
      provider: 'router',
      model: 'typesafe/jev-1.13',
      in_tok: 1000,
      out_tok: 0,
      usd: 0.000042,
      priced_by: 'provider',
    });
    const line = env.lines.find((l) => l.msg === 'llm.decide');
    expect(line).toMatchObject({
      provider: 'router',
      in_tok: 1000,
      questions: 2,
      upstream: 'TypeSafe',
    });
    expect(JSON.stringify(line)).not.toContain('classify this');
    expect(JSON.stringify(env.lines)).not.toContain('sk-or');
  });

  it('prices from the built-in Jev entry when no cost is reported', async () => {
    fake = fakeProviderFactory(usage(1, 1), decision());
    const res = await decide(service());
    expect(res.usd).toBeCloseTo(0.000042, 9);
    expect(res.priced_by).toBe('table');
  });

  it('refuses before the call on the worst case, the run cap and the daily cap', async () => {
    fake = fakeProviderFactory(usage(1, 1), decision(0.001));
    const s = service({ budgets: { daily_usd: 0.0015 } });
    // The body is ~150 chars → ~50 tokens at $0.042/Mtok ≈ $0.0000021.
    await expect(decide(s, { maxUsd: 0.000001 })).rejects.toThrow(/worst case/);
    expect(fake.decides).toHaveLength(0);
    const r = run('triage');
    await expect(decide(s, { maxUsd: 0.01 }, r)).resolves.toMatchObject({ usd: 0.001 });
    await expect(decide(s, { maxUsd: 0.0005 }, r)).rejects.toThrow(/already spent/);
    await expect(decide(s)).resolves.toBeDefined();
    expect(events(BUDGET_EXCEEDED)).toHaveLength(1);
    await expect(decide(s)).rejects.toThrow(/daily budget/);
    expect(fake.decides).toHaveLength(2);
  });

  it('fails non-retryably on a provider whose type has no Decisions API', async () => {
    fake = fakeProviderFactory(usage(1, 1)); // no decide method: an anthropic-style adapter
    const s = service();
    const p = decide(s, { provider: 'anthropic' });
    await expect(p).rejects.toThrow(ProviderUnavailableError);
    await expect(p).rejects.toThrow(/cannot run decide actions/);
    expect(env.store.ledger.sumSince('2000-01-01')).toBe(0);
  });

  it('fails when the model is unpriced and the provider reports no cost, keeping the row at $0', async () => {
    fake = fakeProviderFactory(usage(1, 1), decision());
    const r = run('triage');
    await expect(decide(service(), { model: 'typesafe/jev-9' }, r)).rejects.toThrow(
      UnpricedModelError,
    );
    expect(env.store.ledger.listByRun(r.id)[0]).toMatchObject({ usd: 0, priced_by: 'unpriced' });
  });
});

describe('LlmService.readSystemFile', () => {
  it('reads relative to the config dir and refuses to leave it', () => {
    mkdirSync(join(env.dir, 'prompts'));
    writeFileSync(join(env.dir, 'prompts', 'p.md'), 'system');
    const s = service();
    expect(s.readSystemFile('prompts/p.md')).toBe('system');
    expect(() => s.readSystemFile('../etc/passwd')).toThrow(NonRetryableError);
    expect(() => s.readSystemFile('prompts/nope.md')).toThrow(/cannot read system_file/);
    expect(s.providers()).toEqual(['anthropic', 'router', 'nokey']);
  });
});
