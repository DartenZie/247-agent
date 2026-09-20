import type { LlmDefaultsConfig } from './config.js';
import type {
  LlmCall,
  LlmCallContext,
  LlmCallResult,
  LlmPort,
  LlmRequest,
  LlmResponse,
  ProviderFactory,
  ResolvedProvider,
} from './types.js';

export interface FakeProvider {
  factory: ProviderFactory;
  /** What each `complete` received, with the provider it was built from. */
  requests: { provider: ResolvedProvider; req: LlmRequest }[];
}

/** A provider adapter that records requests and answers with `respond` (or a canned response). */
export function fakeProviderFactory(
  respond: ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>) | LlmResponse = {
    output: { ok: true },
    text: 'ok',
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    stopReason: 'end',
  },
): FakeProvider {
  const requests: FakeProvider['requests'] = [];
  const factory: ProviderFactory = (provider) => ({
    name: provider.name,
    type: provider.type,
    complete: async (req) => {
      requests.push({ provider, req });
      return typeof respond === 'function' ? respond(req) : respond;
    },
  });
  return { factory, requests };
}

export interface FakePort extends LlmPort {
  calls: { req: LlmCall; ctx: LlmCallContext }[];
  systemFiles: Record<string, string>;
}

/** An `LlmPort` for runner tests: records calls, answers with `respond`, serves `systemFiles`. */
export function fakeLlmPort(
  over: {
    defaults?: Partial<LlmDefaultsConfig>;
    systemFiles?: Record<string, string>;
    respond?: (req: LlmCall) => LlmCallResult | Promise<LlmCallResult>;
  } = {},
): FakePort {
  const calls: FakePort['calls'] = [];
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
  return {
    defaults: { max_tokens: 1024, ...over.defaults },
    calls,
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
 * JSON body under `status`, or rejects with it when `reply` is an `Error`.
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
      new Response(JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch };
}
