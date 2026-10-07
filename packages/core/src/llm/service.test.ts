import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isRetryable, NonRetryableError } from '../actions/types.js';
import { createBus, type EventBus } from '../bus/bus.js';
import { testEnv, type TestEnv } from '../bus/testing.js';
import { staticSecrets } from '../secrets/secrets.js';
import type { RunRecord } from '../store/types.js';
import { Batches, type ProviderConfigParsed } from './config.js';
import { BudgetExceededError, ProviderUnavailableError, UnpricedModelError } from './errors.js';
import { resolvePricing } from './pricing.js';
import { BUDGET_EXCEEDED, LlmService, type LlmServiceOptions } from './service.js';
import { fakeProviderFactory, type FakeProvider } from './testing.js';
import { LLM_BATCH_ENDED } from '../bus/matcher.js';
import type { BatchStatus, DecideCall, DecideResponse, LlmCall, LlmResponse } from './types.js';

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

describe('LlmService agent turns (checkBudget + record)', () => {
  const cctx = (r: RunRecord) => ({
    run: r,
    task: r.task,
    signal: new AbortController().signal,
    log: env.log,
  });

  it('records a reported cost under the connector name, then prices tokens from the table', () => {
    const s = service();
    const r = run('agent_task');
    const first = s.record(
      {
        provider: 'claude',
        model: 'claude-sonnet-5',
        maxUsd: 1,
        usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.05 },
      },
      cctx(r),
    );
    expect(first).toMatchObject({ usd: 0.05, priced_by: 'provider' });
    const second = s.record(
      {
        provider: 'claude',
        model: 'claude-sonnet-5',
        maxUsd: 1,
        usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      },
      cctx(r),
    );
    expect(second.priced_by).toBe('table');
    expect(second.usd).toBeCloseTo(0.003); // sonnet: 1000 in at $2/M + 100 out at $10/M
    expect(env.store.ledger.listByRun(r.id)).toMatchObject([
      { provider: 'claude', model: 'claude-sonnet-5', usd: 0.05, priced_by: 'provider' },
      { provider: 'claude', model: 'claude-sonnet-5', priced_by: 'table' },
    ]);
    expect(env.lines.filter((l) => l.msg === 'agent.turn')).toHaveLength(2);
    expect(env.lines.at(-1)).toMatchObject({
      msg: 'agent.turn',
      run_usd: expect.closeTo(0.053, 4) as number,
    });
  });

  it('fails an unpriced turn and an overrun, keeping the rows', () => {
    const s = service();
    const r = run();
    expect(() =>
      s.record(
        {
          provider: 'gemini',
          model: 'gemini-x',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
        cctx(r),
      ),
    ).toThrow(UnpricedModelError);
    expect(() =>
      s.record(
        {
          provider: 'claude',
          model: 'claude-sonnet-5',
          maxUsd: 0.01,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.02 },
        },
        cctx(r),
      ),
    ).toThrow(BudgetExceededError);
    expect(env.store.ledger.listByRun(r.id)).toMatchObject([
      { priced_by: 'unpriced', usd: 0 },
      { priced_by: 'provider', usd: 0.02 },
    ]);
  });

  it('checkBudget refuses a run that already spent its cap and a day over the daily cap', () => {
    const s = service({ budgets: { daily_usd: 0.1 } });
    const r = run();
    s.checkBudget({ maxUsd: 0.05 }, cctx(r));
    s.record(
      {
        provider: 'claude',
        model: 'claude-sonnet-5',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.05 },
      },
      cctx(r),
    );
    expect(() => {
      s.checkBudget({ maxUsd: 0.05 }, cctx(r));
    }).toThrow(/already spent/);
    s.checkBudget({}, cctx(r)); // no run cap: fine while the day is under its cap
    s.record(
      {
        provider: 'claude',
        model: 'claude-sonnet-5',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.05 },
      },
      cctx(r),
    );
    expect(events(BUDGET_EXCEEDED)).toHaveLength(1);
    expect(() => {
      s.checkBudget({}, cctx(run()));
    }).toThrow(/daily budget/);
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

describe('LlmService batches', () => {
  const ctxOf = (r: RunRecord) => ({
    run: r,
    task: r.task,
    signal: new AbortController().signal,
    log: env.log,
  });
  const req: LlmCall = {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    input: 'classify this',
    outputSchema: { type: 'object' },
    maxTokens: 100,
  };
  let status: BatchStatus;
  const withBatches = (over: Partial<LlmServiceOptions> = {}): LlmService => {
    fake = fakeProviderFactory(usage(1000, 100), undefined, () => status);
    return service({ factories: { anthropic: fake.factory }, ...over });
  };
  const poll = (s: LlmService) => s.pollBatches(new AbortController().signal);

  it('submits once per run, keyed by the run id, and records the batch in flight', async () => {
    const s = withBatches();
    const r = run();
    await expect(
      s.submitBatch({ ...req, system: 'sys', effort: 'low' }, ctxOf(r)),
    ).resolves.toEqual({ batchId: 'msgbatch_1', reused: false });
    expect(fake.batches[0]?.req).toMatchObject({
      customId: r.id,
      system: 'sys',
      input: 'classify this',
      outputSchema: { type: 'object' },
      effort: 'low',
    });
    expect(env.store.batches.list()).toEqual([
      expect.objectContaining({
        batch_id: 'msgbatch_1',
        run_id: r.id,
        task: 'classify',
        attempt: 0,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        structured: true,
      }),
    ]);
    // A restart before the run was parked: the same batch, nothing submitted again.
    await expect(s.submitBatch(req, ctxOf(r))).resolves.toEqual({
      batchId: 'msgbatch_1',
      reused: true,
    });
    expect(fake.batches).toHaveLength(1);
    expect(env.store.ledger.listByRun(r.id)).toEqual([]);
  });

  it('checks the worst case at the batch price and refuses a provider without a batch API', async () => {
    const s = withBatches();
    // Haiku worst case: 100 output tokens at $5/Mtok = $0.0005, half of it in a batch.
    await expect(s.submitBatch({ ...req, maxUsd: 0.0003 }, ctxOf(run()))).resolves.toMatchObject({
      reused: false,
    });
    await expect(s.submitBatch({ ...req, maxUsd: 0.0002 }, ctxOf(run()))).rejects.toThrow(
      BudgetExceededError,
    );
    const plain = service({ factories: { anthropic: fakeProviderFactory().factory } }); // no batch methods
    await expect(plain.submitBatch(req, ctxOf(run()))).rejects.toThrow(ProviderUnavailableError);
    await expect(plain.submitBatch(req, ctxOf(run()))).rejects.toThrow(
      /needs an anthropic provider/,
    );
  });

  it('bounds batches.poll to 1s..1h', () => {
    expect(Batches.safeParse({ poll: '1s' }).success).toBe(true);
    expect(Batches.safeParse({ poll: '1h' }).success).toBe(true);
    expect(Batches.safeParse({ poll: '0s' }).success).toBe(false);
    expect(Batches.safeParse({ poll: '2h' }).success).toBe(false);
    expect(Batches.safeParse({ poll: 'soon' }).success).toBe(false);
  });

  it('reserves the worst case of batches in flight against the daily cap', async () => {
    // Each worst case is ~$0.00025 at the batch price: two fit under $0.0006, a third does not.
    const s = withBatches({ budgets: { daily_usd: 0.0006 } });
    await s.submitBatch(req, ctxOf(run()));
    await s.submitBatch(req, ctxOf(run()));
    expect(env.store.batches.reservedUsd()).toBeCloseTo(0.0005, 4);
    await expect(s.submitBatch(req, ctxOf(run()))).rejects.toThrow(/reserved by batches in flight/);
    expect(fake.batches).toHaveLength(2);
    // An unbilled end frees its reservation.
    status = { status: 'expired', error: 'expired', retryable: true };
    await poll(s);
    expect(env.store.batches.reservedUsd()).toBe(0);
    await expect(s.submitBatch(req, ctxOf(run()))).resolves.toMatchObject({ reused: false });
  });

  it('leaves a batch in progress alone and settles a succeeded one at half price', async () => {
    const s = withBatches();
    const r = run();
    await s.submitBatch(req, ctxOf(r));
    status = { status: 'in_progress' };
    await expect(poll(s)).resolves.toEqual({ ended: 0, pending: 1, failed: 0, abandoned: 0 });
    expect(events(LLM_BATCH_ENDED)).toEqual([]);
    status = { status: 'succeeded', response: usage(1000, 100) };
    await expect(poll(s)).resolves.toEqual({ ended: 1, pending: 0, failed: 0, abandoned: 0 });
    expect(fake.polls[1]).toMatchObject({
      batchId: 'msgbatch_1',
      customId: r.id,
      structured: true,
    });
    const rows = env.store.ledger.listByRun(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usd).toBeCloseTo(0.00075); // ($0.001 + $0.0005) / 2
    expect(rows[0]).toMatchObject({ provider: 'anthropic', in_tok: 1000, priced_by: 'table' });
    const ended = events(LLM_BATCH_ENDED);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      source: 'core',
      parent_id: r.event_id,
      correlation_id: r.correlation_id,
      dedup_key: 'llm.batch:msgbatch_1',
      payload: {
        batch_id: 'msgbatch_1',
        run_id: r.id,
        task: 'classify',
        status: 'succeeded',
        stop_reason: 'end',
        output: { kind: 'x' },
        usage: { input: 1000, output: 100, cache_read: 0, cache_write: 0 },
        priced_by: 'table',
        ledger_id: rows[0]?.id,
      },
    });
    expect(env.store.batches.count()).toBe(0);
    await expect(poll(s)).resolves.toEqual({ ended: 0, pending: 0, failed: 0, abandoned: 0 });
  });

  it('publishes an unbilled failure without a ledger row', async () => {
    const s = withBatches();
    const r = run();
    await s.submitBatch(req, ctxOf(r));
    status = { status: 'expired', error: 'expired', retryable: true };
    await poll(s);
    expect(env.store.ledger.listByRun(r.id)).toEqual([]);
    expect(events(LLM_BATCH_ENDED)[0]?.payload).toEqual({
      batch_id: 'msgbatch_1',
      run_id: r.id,
      task: 'classify',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      status: 'expired',
      error: 'expired',
      retryable: true,
    });
  });

  it('ledgers a billed but unusable result and reports it as errored', async () => {
    const s = withBatches();
    const r = run();
    await s.submitBatch(req, ctxOf(r));
    status = { status: 'succeeded', response: usage(1000, 100), error: 'not JSON' };
    await poll(s);
    expect(env.store.ledger.listByRun(r.id)).toHaveLength(1);
    expect(events(LLM_BATCH_ENDED)[0]?.payload).toMatchObject({
      status: 'errored',
      error: 'not JSON',
      retryable: true,
    });
  });

  it('keeps polling after a failed poll and abandons a batch after a week', async () => {
    const s = withBatches();
    await s.submitBatch(req, ctxOf(run()));
    await s.submitBatch(req, ctxOf(run()));
    const throwing = service({
      factories: {
        anthropic: (p) => ({
          ...fakeProviderFactory().factory(p),
          pollBatch: () => Promise.reject(new Error('503 overloaded')),
        }),
      },
    });
    await expect(poll(throwing)).resolves.toEqual({
      ended: 0,
      pending: 2,
      failed: 2,
      abandoned: 0,
    });
    expect(env.store.batches.count()).toBe(2);
    expect(env.lines.filter((l) => l.msg === 'llm.batch_poll_failed')).toHaveLength(2);
    env.clock.set('2026-09-27T10:00:00.000Z'); // 8 days later
    status = { status: 'in_progress' };
    await expect(poll(s)).resolves.toMatchObject({ pending: 0, abandoned: 2 });
    expect(env.store.batches.count()).toBe(0);
    expect(events(LLM_BATCH_ENDED)).toEqual([]);
  });

  it('reads a payload back and applies the post-hoc run budget', async () => {
    const s = withBatches();
    const r = run();
    await s.submitBatch(req, ctxOf(r));
    status = { status: 'succeeded', response: usage(1000, 100) };
    await poll(s);
    const payload = events(LLM_BATCH_ENDED)[0]?.payload ?? null;
    const res = s.batchResult(payload, { maxUsd: 1 }, ctxOf(r));
    expect(res).toMatchObject({
      status: 'succeeded',
      result: { output: { kind: 'x' }, stopReason: 'end', priced_by: 'table' },
    });
    expect(() => s.batchResult(payload, { maxUsd: 0.0005 }, ctxOf(r))).toThrow(BudgetExceededError);
    expect(
      s.batchResult(
        { ...(payload as object), status: 'errored', error: 'bad', retryable: false },
        {},
        ctxOf(r),
      ),
    ).toEqual({ status: 'errored', error: 'bad', retryable: false });
    expect(() => s.batchResult({ nope: true }, {}, ctxOf(r))).toThrow(NonRetryableError);
  });
});
