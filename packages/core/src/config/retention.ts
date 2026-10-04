import { z } from 'zod';

import { DURATION, parseDuration } from './duration.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A duration, or `never` to keep that kind forever. */
const keepFor = z.union([
  z.string().regex(DURATION, 'durations look like 7d, 90d, 24h; or never'),
  z.literal('never'),
]);

/**
 * `retention:` in agent.yaml (docs/internal/config.md): how long finished runs, ledger rows,
 * events and agent workspaces are kept before the retention pass deletes them. A run's
 * ledger rows go with the run at the latest, so `ledger` cannot exceed `runs`; an event
 * stays as long as a kept run references it, whatever `events` says.
 */
export const Retention = z
  .strictObject({
    /** Events older than this and not referenced by a kept run. */
    events: keepFor.default('90d'),
    /** Runs in a terminal status whose `finished_at` is older than this, with their ledger rows. */
    runs: keepFor.default('90d'),
    /** Ledger rows older than this, run kept or not; defaults to `runs`. */
    ledger: keepFor.optional(),
    /** `work/<run_id>` directories of runs finished longer ago than this (or with no run). */
    workspaces: keepFor.default('7d'),
    /** How often the pass runs; it also runs once at start. */
    interval: z.string().regex(DURATION, 'durations look like 30m, 1h, 24h').default('1h'),
  })
  .prefault({})
  .superRefine((r, ctx) => {
    // The daily budget sums today's ledger rows; purging any of them would lift the cap.
    for (const key of ['runs', 'ledger'] as const) {
      const v = r[key];
      if (v !== undefined && v !== 'never' && parseDuration(v) < DAY_MS) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'keep at least 1d: the daily budget is summed from the ledger rows of today',
        });
      }
    }
    if (r.ledger === undefined || r.ledger === 'never') {
      if (r.ledger === 'never' && r.runs !== 'never') {
        ctx.addIssue({
          code: 'custom',
          path: ['ledger'],
          message: 'ledger rows are deleted with their run: ledger cannot outlive runs',
        });
      }
      return;
    }
    if (r.runs !== 'never' && parseDuration(r.ledger) > parseDuration(r.runs)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ledger'],
        message: 'ledger rows are deleted with their run: ledger cannot outlive runs',
      });
    }
  });

export type RetentionConfig = z.infer<typeof Retention>;

/** The policy in milliseconds; `undefined` = keep forever. */
export interface RetentionPolicy {
  eventsMs: number | undefined;
  runsMs: number | undefined;
  ledgerMs: number | undefined;
  workspacesMs: number | undefined;
  intervalMs: number;
}

function ms(v: string | undefined): number | undefined {
  return v === undefined || v === 'never' ? undefined : parseDuration(v);
}

export function retentionPolicy(cfg: RetentionConfig): RetentionPolicy {
  return {
    eventsMs: ms(cfg.events),
    runsMs: ms(cfg.runs),
    ledgerMs: ms(cfg.ledger ?? cfg.runs),
    workspacesMs: ms(cfg.workspaces),
    intervalMs: parseDuration(cfg.interval),
  };
}
