import {
  DEFAULT_DECIDE_MODEL,
  type DecideDefaultsConfig,
  type LlmDefaultsConfig,
} from './config.js';
import type { JsonValue } from '../store/types.js';
import type {
  AgentTurn,
  AgentTurnResult,
  BatchCallResult,
  BatchPollRequest,
  BatchStatus,
  BatchSubmitRequest,
  BatchSubmitResult,
  DecideCall,
  DecideCallResult,
  DecideRequest,
  DecideResponse,
  LlmCall,
  LlmCallContext,
  LlmCallResult,
  LlmPort,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderFactory,
  ResolvedProvider,
} from './types.js';

export interface FakeProvider {
  factory: ProviderFactory;
  /** What each `complete` received, with the provider it was built from. */
  requests: { provider: ResolvedProvider; req: LlmRequest }[];
  /** What each `decide` received. */
  decides: { provider: ResolvedProvider; req: DecideRequest }[];
  /** What each `submitBatch` received; batch ids are `msgbatch_<n>` from 1. */
  batches: { provider: ResolvedProvider; req: BatchSubmitRequest }[];
  /** What each `pollBatch` received. */
  polls: BatchPollRequest[];
}

/**
 * A provider adapter that records requests and answers with `respond` (or a canned response).
 * It has a `decide` method only when `decide` is given, so a provider type that cannot reach
 * the Decisions API is the default; likewise `submitBatch`/`pollBatch` only with `poll`.
 */
export function fakeProviderFactory(
  respond: ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>) | LlmResponse = {
    output: { ok: true },
    text: 'ok',
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    stopReason: 'end',
  },
  decide?: ((req: DecideRequest) => DecideResponse | Promise<DecideResponse>) | DecideResponse,
  poll?: (req: BatchPollRequest) => BatchStatus | Promise<BatchStatus>,
): FakeProvider {
  const requests: FakeProvider['requests'] = [];
  const decides: FakeProvider['decides'] = [];
  const batches: FakeProvider['batches'] = [];
  const polls: FakeProvider['polls'] = [];
  const factory: ProviderFactory = (provider) => {
    const adapter: LlmProvider = {
      name: provider.name,
      type: provider.type,
      complete: async (req) => {
        requests.push({ provider, req });
        return typeof respond === 'function' ? respond(req) : respond;
      },
    };
    if (decide !== undefined) {
      adapter.decide = async (req) => {
        decides.push({ provider, req });
        return typeof decide === 'function' ? decide(req) : decide;
      };
    }
    if (poll !== undefined) {
      adapter.submitBatch = (req) => {
        batches.push({ provider, req });
        return Promise.resolve({ batchId: `msgbatch_${String(batches.length)}` });
      };
      adapter.pollBatch = async (req) => {
        polls.push(req);
        return poll(req);
      };
    }
    return adapter;
  };
  return { factory, requests, decides, batches, polls };
}

export interface FakePort extends LlmPort {
  calls: { req: LlmCall; ctx: LlmCallContext }[];
  decides: { req: DecideCall; ctx: LlmCallContext }[];
  /** What `record` received (agent turns). */
  turns: { turn: AgentTurn; ctx: LlmCallContext }[];
  /** What `submitBatch` received. */
  batches: { req: LlmCall; ctx: LlmCallContext }[];
  /** What `batchResult` received. */
  batchResults: { payload: JsonValue; maxUsd: number | undefined }[];
  systemFiles: Record<string, string>;
}

/** An `LlmPort` for runner tests: records calls, answers with `respond`, serves `systemFiles`. */
export function fakeLlmPort(
  over: {
    defaults?: Partial<LlmDefaultsConfig>;
    decideDefaults?: Partial<DecideDefaultsConfig>;
    systemFiles?: Record<string, string>;
    respond?: (req: LlmCall) => LlmCallResult | Promise<LlmCallResult>;
    respondDecide?: (req: DecideCall) => DecideCallResult | Promise<DecideCallResult>;
    /** Throws to simulate a budget refusal before a turn. */
    checkBudget?: (req: { maxUsd?: number | undefined }) => void;
    /** Prices an agent turn; defaults to the reported cost or $0.001. */
    record?: (turn: AgentTurn) => AgentTurnResult;
    /** Answers `submitBatch`; defaults to a new `msgbatch_<n>`. */
    submitBatch?: (req: LlmCall) => BatchSubmitResult | Promise<BatchSubmitResult>;
    /** Answers `batchResult`; defaults to a succeeded `{ok: true}`. */
    batchResult?: (payload: JsonValue) => BatchCallResult;
  } = {},
): FakePort {
  const calls: FakePort['calls'] = [];
  const decides: FakePort['decides'] = [];
  const turns: FakePort['turns'] = [];
  const batches: FakePort['batches'] = [];
  const batchResults: FakePort['batchResults'] = [];
  const systemFiles = over.systemFiles ?? {};
  const respond =
    over.respond ??
    ((): LlmCallResult => ({
      output: { ok: true },
      text: 'ok',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'end',
      usd: 0.001,
      priced_by: 'table',
      ledgerId: 1,
    }));
  const respondDecide =
    over.respondDecide ??
    ((): DecideCallResult => ({
      answers: {},
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      usd: 0.00001,
      priced_by: 'provider',
      ledgerId: 1,
    }));
  return {
    defaults: { max_tokens: 1024, ...over.defaults },
    decideDefaults: { model: DEFAULT_DECIDE_MODEL, ...over.decideDefaults },
    calls,
    decides,
    turns,
    batches,
    batchResults,
    systemFiles,
    providers: () => ['fake'],
    readSystemFile: (rel) => {
      const text = systemFiles[rel];
      if (text === undefined) {
        throw new Error(`no such system file ${rel}`);
      }
      return text;
    },
    call: async (req, ctx) => {
      calls.push({ req, ctx });
      return respond(req);
    },
    decide: async (req, ctx) => {
      decides.push({ req, ctx });
      return respondDecide(req);
    },
    submitBatch: async (req, ctx) => {
      batches.push({ req, ctx });
      if (over.submitBatch !== undefined) {
        return over.submitBatch(req);
      }
      return { batchId: `msgbatch_${String(batches.length)}`, reused: false };
    },
    batchResult: (payload, req) => {
      batchResults.push({ payload, maxUsd: req.maxUsd });
      if (over.batchResult !== undefined) {
        return over.batchResult(payload);
      }
      return {
        status: 'succeeded',
        result: {
          output: { ok: true },
          text: 'ok',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          stopReason: 'end',
          usd: 0.0005,
          priced_by: 'table',
          ledgerId: 1,
        },
      };
    },
    checkBudget: (req) => {
      over.checkBudget?.(req);
    },
    record: (turn, ctx) => {
      turns.push({ turn, ctx });
      if (over.record !== undefined) {
        return over.record(turn);
      }
      const reported = turn.usage.reportedUsd;
      return {
        usd: reported ?? 0.001,
        priced_by: reported === undefined ? 'table' : 'provider',
        ledgerId: turns.length,
      };
    },
  };
}

/** One request as a `recordingFetch` transport saw it. */
export interface CapturedRequest {
  url: string;
  headers: Headers;
  /** The JSON body, parsed. */
  body: Record<string, unknown>;
  /** The body as sent, for "the key is not in here" assertions. */
  raw: string;
}

/** Structurally the `fetch` option of both vendor SDKs. */
export type RecordingFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A transport for adapter tests: records every request and answers each with `reply` as a
 * JSON body under `status`, or rejects with it when `reply` is an `Error`. A string `reply`
 * is sent verbatim (a non-JSON body).
 */
export function recordingFetch(
  reply: unknown,
  status = 200,
): { calls: CapturedRequest[]; fetch: RecordingFetch } {
  const calls: CapturedRequest[] = [];
  const fetch: RecordingFetch = (input, init) => {
    const raw = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(raw) as Record<string, unknown>,
      raw,
    });
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch };
}
