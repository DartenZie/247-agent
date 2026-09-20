import { Cron, type CronOptions } from 'croner';
import { search } from 'jmespath';
import { z } from 'zod';

import type { ConnectorClients } from '../actions/types.js';
import type { EventBus } from '../bus/bus.js';
import type { Clock } from '../clock.js';
import type { ConnectorConfig } from '../config/connector.js';
import { DURATION, parseDuration } from '../config/duration.js';
import {
  validateCron,
  validateEventType,
  validateJmespath,
  validateTimezone,
} from '../config/validators.js';
import { collectTemplateRefs, renderValue } from '../expr/template.js';
import type { Logger } from '../log.js';
import type { SecretsBackend } from '../secrets/secrets.js';
import type { Store } from '../store/store.js';
import type { JsonValue } from '../store/types.js';

const NAME = /^[a-z][a-z0-9_-]*$/;

/** The state key under the poller's own namespace that holds the keys already emitted. */
export const SEEN_KEY = 'seen';

/**
 * The `config` of a `builtin: poller` manifest (ARCHITECTURE §6): on `schedule`, call
 * `connector.op` with `args`, take `items` (a JMESPath over the result; the result itself
 * when omitted), key each item with `item_key`, and emit `event` once per key not seen
 * before. Seen keys live in the state KV as `<poller name>/seen`, newest last, at most
 * `keep` of them. `first_run: skip` marks everything seen on the very first poll instead
 * of emitting it (useful when the op lists what already exists, like open PRs).
 */
export const PollerConfig = z
  .strictObject({
    schedule: z.string().min(1),
    tz: z.string().optional(),
    connector: z.string().regex(NAME, 'connector names are [a-z][a-z0-9_-]*'),
    op: z.string().min(1),
    /** Passed to the op as is; values take `${secrets.<name>}` and `${env.<VAR>}`. */
    args: z.record(z.string(), z.unknown()).default({}),
    /** Per op call. */
    timeout: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').optional(),
    /** JMESPath over the op result yielding the array of items; the result itself when omitted. */
    items: z.string().min(1).optional(),
    /** JMESPath over one item yielding its identity (a string or a number). */
    item_key: z.string().min(1),
    /** The event type emitted once per new item; the item is the payload. */
    event: z.string().min(1),
    first_run: z.enum(['emit', 'skip']).default('emit'),
    /** How many seen keys to remember. */
    keep: z.number().int().positive().default(1000),
  })
  .superRefine((c, ctx) => {
    const tzError = validateTimezone(c.tz);
    if (tzError !== null) {
      ctx.addIssue({ code: 'custom', path: ['tz'], message: tzError });
    } else {
      const cronError = validateCron(c.schedule, c.tz);
      if (cronError !== null) {
        ctx.addIssue({ code: 'custom', path: ['schedule'], message: cronError });
      }
    }
    for (const field of ['items', 'item_key'] as const) {
      const expr = c[field];
      if (expr === undefined) {
        continue;
      }
      const err = validateJmespath(expr);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: [field], message: `invalid JMESPath: ${err}` });
      }
    }
    const typeError = validateEventType(c.event);
    if (typeError !== null) {
      ctx.addIssue({ code: 'custom', path: ['event'], message: typeError });
    }
  });

export type PollerConfigValues = z.infer<typeof PollerConfig>;

export interface PollerOptions {
  /** A manifest with `builtin: poller`. */
  manifest: ConnectorConfig;
  /** Where `connector.op` is called. */
  clients: ConnectorClients;
  store: Store;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  secrets: SecretsBackend;
  /** The `env` template scope for `args`. */
  env?: Record<string, string>;
  /** Per-op default when the config names no `timeout`. */
  callTimeoutMs?: number;
}

export interface PollerStatus {
  name: string;
  connector: string;
  op: string;
  schedule: string;
  next_run: string | null;
  last_poll: string | null;
  /** The last poll's error, cleared by the next successful one. */
  last_error: string | null;
  polling: boolean;
}

export type PollResult =
  | {
      status: 'polled';
      /** Items the op returned. */
      items: number;
      /** Items whose key was not in the seen list. */
      new: number;
      /** Events published (`new`, minus `first_run: skip` and `dedup_key` collisions). */
      emitted: number;
      /** New items whose `dedup_key` already had an event. */
      duplicates: number;
    }
  | { status: 'skipped'; reason: 'in_flight' }
  | { status: 'failed'; error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function typeName(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  return Array.isArray(v) ? 'array' : typeof v;
}

/** The persisted seen list, or `undefined` when it is missing or malformed. */
function readSeen(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || !value.every((k) => typeof k === 'string')) {
    return undefined;
  }
  return value;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * The built-in `poller` connector (ARCHITECTURE §6): turns any connector op into an event
 * source without a process of its own. Runs inside the core; polling, dedup and the seen
 * list stay observable in the log and the state KV. A poll that fails (connector down,
 * op error, result of the wrong shape) is logged and left to the next tick; a tick while a
 * poll is in flight is skipped.
 */
export class Poller {
  readonly name: string;
  private readonly clients: ConnectorClients;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly secrets: SecretsBackend;
  private readonly env: Record<string, string>;
  private readonly callTimeoutMs: number;
  /** Validated, unrendered: secrets are rendered into `args` at each poll and never kept. */
  private readonly config: PollerConfigValues;
  private job: Cron | undefined;
  private inFlight: Promise<PollResult> | undefined;
  private abort: AbortController | undefined;
  private lastPoll: string | null = null;
  private lastError: string | null = null;

  constructor(opts: PollerOptions) {
    if (opts.manifest.builtin !== 'poller') {
      throw new Error(`connector "${opts.manifest.name}" is not a poller`);
    }
    this.name = opts.manifest.name;
    this.clients = opts.clients;
    this.store = opts.store;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.log = opts.log.child({ connector: this.name });
    this.secrets = opts.secrets;
    this.env = opts.env ?? {};
    this.callTimeoutMs = opts.callTimeoutMs ?? 60_000;
    this.config = PollerConfig.parse(opts.manifest.config);
  }

  status(): PollerStatus {
    return {
      name: this.name,
      connector: this.config.connector,
      op: this.config.op,
      schedule: this.config.schedule,
      next_run: this.job?.nextRun()?.toISOString() ?? null,
      last_poll: this.lastPoll,
      last_error: this.lastError,
      polling: this.inFlight !== undefined,
    };
  }

  /** Arms the cron job. The first poll happens at the next boundary, not now. */
  start(): void {
    this.stopJob();
    const options: CronOptions = {
      name: `poller:${this.name}`,
      catch: (err: unknown) => {
        this.log.error('poller.tick_failed', { error: errorMessage(err) });
      },
      ...(this.config.tz === undefined ? {} : { timezone: this.config.tz }),
    };
    this.job = new Cron(this.config.schedule, options, () => {
      void this.poll();
    });
    this.log.info('poller.armed', {
      connector: this.config.connector,
      op: this.config.op,
      schedule: this.config.schedule,
      next_run: this.job.nextRun()?.toISOString() ?? null,
    });
  }

  /** Disarms the cron job, aborts a poll in flight and waits for it to settle. */
  async stop(): Promise<void> {
    this.stopJob();
    this.abort?.abort();
    await this.inFlight;
  }

  /**
   * One poll: call the op, diff its items against the seen list, publish the new ones.
   * Safe to call by hand (tests, a future `oa connectors poll`); never throws.
   */
  poll(): Promise<PollResult> {
    if (this.inFlight !== undefined) {
      this.log.debug('poller.skipped', { reason: 'in_flight' });
      return Promise.resolve({ status: 'skipped', reason: 'in_flight' });
    }
    const run = this.pollOnce().finally(() => {
      this.inFlight = undefined;
      this.abort = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async pollOnce(): Promise<PollResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    this.abort = controller;
    try {
      const args = this.renderArgs();
      const result = await this.clients.call(this.config.connector, this.config.op, args, {
        signal: controller.signal,
        timeoutMs:
          this.config.timeout === undefined
            ? this.callTimeoutMs
            : parseDuration(this.config.timeout),
      });
      const outcome = this.diffAndEmit(result);
      this.lastError = null;
      this.log.info('poller.polled', {
        connector: this.config.connector,
        op: this.config.op,
        items: outcome.items,
        new: outcome.new,
        emitted: outcome.emitted,
        duplicates: outcome.duplicates,
        duration_ms: Date.now() - startedAt,
      });
      return outcome;
    } catch (err) {
      const error = errorMessage(err);
      this.lastError = error;
      this.log.error('poller.failed', {
        connector: this.config.connector,
        op: this.config.op,
        error,
        duration_ms: Date.now() - startedAt,
      });
      return { status: 'failed', error };
    } finally {
      this.lastPoll = this.clock.now().toISOString();
    }
  }

  /** `args` with `${secrets.<name>}` and `${env.<VAR>}` rendered; resolved fresh each poll. */
  private renderArgs(): Record<string, JsonValue> {
    const refs = collectTemplateRefs(this.config.args);
    const secrets = this.secrets.resolve(refs.secrets);
    return renderValue(this.config.args, { secrets, env: this.env }) as Record<string, JsonValue>;
  }

  private diffAndEmit(result: JsonValue): Extract<PollResult, { status: 'polled' }> {
    const cfg = this.config;
    const items: unknown = cfg.items === undefined ? result : search(result, cfg.items);
    if (!Array.isArray(items)) {
      throw new Error(
        `${cfg.items === undefined ? 'the result' : `items "${cfg.items}"`} is not an array (got ${typeName(items)})`,
      );
    }
    const keys = items.map((item, i) => {
      const key: unknown = search(item, cfg.item_key);
      if (typeof key === 'string' && key !== '') {
        return key;
      }
      if (typeof key === 'number' && Number.isFinite(key)) {
        return String(key);
      }
      throw new Error(
        `item_key "${cfg.item_key}" of item ${String(i)} is not a string or a number (got ${typeName(key)})`,
      );
    });
    // The events and the seen list move together: a crash between them would either
    // re-emit (caught by dedup_key) or silently lose items.
    return this.store.transaction(() => {
      const entry = this.store.state.get(this.name, SEEN_KEY);
      const seen = readSeen(entry?.value);
      if (entry !== undefined && seen === undefined) {
        this.log.warn('poller.seen_invalid', { key: SEEN_KEY });
      }
      const seenSet = new Set(seen ?? []);
      const first = entry === undefined;
      const batch = new Set<string>();
      let fresh = 0;
      let emitted = 0;
      let duplicates = 0;
      items.forEach((item, i) => {
        const key = keys[i];
        if (key === undefined || seenSet.has(key) || batch.has(key)) {
          return;
        }
        batch.add(key);
        fresh++;
        if (first && cfg.first_run === 'skip') {
          return;
        }
        const r = this.bus.publish({
          type: cfg.event,
          source: this.name,
          dedup_key: `${this.name}:${key}`,
          payload: item as JsonValue,
        });
        if (r.status === 'inserted') {
          emitted++;
        } else {
          duplicates++;
          this.log.debug('poller.emit_duplicate', {
            event_type: cfg.event,
            dedup_key: r.dedup_key,
          });
        }
      });
      // Keys still returned by the op count as freshly seen; older ones age out first.
      const current = [...new Set(keys)];
      const currentSet = new Set(current);
      const next = [...(seen ?? []).filter((k) => !currentSet.has(k)), ...current].slice(-cfg.keep);
      if (seen === undefined || !sameList(seen, next)) {
        this.store.state.put(this.name, SEEN_KEY, next, this.clock.now().toISOString());
      }
      if (first && cfg.first_run === 'skip' && fresh > 0) {
        this.log.info('poller.seeded', { items: fresh });
      }
      return { status: 'polled', items: items.length, new: fresh, emitted, duplicates };
    });
  }

  private stopJob(): void {
    this.job?.stop();
    this.job = undefined;
  }
}
