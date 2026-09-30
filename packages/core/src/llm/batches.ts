import { z } from 'zod';

import type { Logger } from '../log.js';

/** The longest delay `setTimeout`/`setInterval` accept (2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long a run waits for its batch. Anthropic ends every batch within 24 hours (requests
 * not processed by then come back `expired`); the extra hour covers polling. Past it the
 * wait times out and the run fails; the batch is still settled if it ends later.
 */
export const BATCH_WAIT_MS = 25 * 60 * 60 * 1000;

/**
 * A batch the poller could not settle for this long is dropped from `llm_batches` with an
 * `llm.batch_abandoned` error (a provider removed from agent.yaml, a revoked key): results
 * stay retrievable for 29 days, but a batch always ends within 24 hours.
 */
export const BATCH_ABANDON_MS = 7 * 24 * 60 * 60 * 1000;

const Usage = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative(),
  cache_write: z.number().nonnegative(),
});

/**
 * The payload of `llm.batch.ended` (ARCHITECTURE §5.2). `succeeded` carries the result as
 * the ledger priced it; `errored`, `expired` and `canceled` carry the provider's reason and
 * whether resubmitting can help. An `errored` batch with `usd` was billed but unusable (a
 * structured output that is not JSON).
 */
export const BatchEndedPayload = z.object({
  batch_id: z.string(),
  run_id: z.string(),
  task: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['succeeded', 'errored', 'expired', 'canceled']),
  stop_reason: z.enum(['end', 'max_tokens', 'refusal', 'other']).optional(),
  output: z.json().optional(),
  text: z.string().optional(),
  usage: Usage.optional(),
  usd: z.number().optional(),
  priced_by: z.enum(['table', 'provider', 'unpriced']).optional(),
  ledger_id: z.number().int().optional(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type BatchEndedPayload = z.infer<typeof BatchEndedPayload>;

export interface BatchPollReport {
  /** Batches settled this pass (ledgered where billed, `llm.batch.ended` published). */
  ended: number;
  /** Batches still in progress. */
  pending: number;
  /** Batches whose poll failed; tried again next pass. */
  failed: number;
  /** Batches dropped after `BATCH_ABANDON_MS`. */
  abandoned: number;
}

/** What the poller drives: `LlmService.pollBatches`. */
export interface BatchSource {
  pollBatches(signal: AbortSignal): Promise<BatchPollReport>;
}

export interface BatchPollerOptions {
  source: BatchSource;
  log: Logger;
  /** `batches.poll` from agent.yaml. */
  intervalMs: number;
}

/**
 * The timer behind `batch: true` (ARCHITECTURE §5.2): once at start and then every
 * `batches.poll`, the service checks every batch in flight. A pass never overlaps the
 * previous one, errors are logged and retried next pass, and `stop()` aborts the pass in
 * flight (a batch fetched but not settled is fetched again after the restart).
 */
export class BatchPoller {
  private readonly source: BatchSource;
  private readonly log: Logger;
  private intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<BatchPollReport | undefined> | undefined;
  private abort = new AbortController();
  private stopped = true;

  constructor(opts: BatchPollerOptions) {
    this.source = opts.source;
    this.log = opts.log;
    this.intervalMs = opts.intervalMs;
  }

  start(): void {
    this.stopped = false;
    this.abort = new AbortController();
    this.arm();
    void this.run();
  }

  /** Reload seam: re-arms the timer only when the interval changed. */
  configure(intervalMs: number): void {
    const rearm = intervalMs !== this.intervalMs;
    this.intervalMs = intervalMs;
    if (rearm && !this.stopped) {
      this.arm();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abort.abort();
    await this.inFlight;
  }

  /** One pass now; a pass already running is awaited instead. Never throws. */
  run(): Promise<BatchPollReport | undefined> {
    this.inFlight ??= this.runOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private arm(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(
      () => {
        void this.run();
      },
      Math.min(this.intervalMs, MAX_TIMER_MS),
    );
    this.timer.unref();
  }

  private async runOnce(): Promise<BatchPollReport | undefined> {
    try {
      const report = await this.source.pollBatches(this.abort.signal);
      if (report.ended + report.failed + report.abandoned > 0) {
        this.log.info('llm.batches_polled', { ...report });
      }
      return report;
    } catch (err) {
      this.log.error('llm.batches_poll_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}
