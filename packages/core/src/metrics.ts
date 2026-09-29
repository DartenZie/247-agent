/**
 * Prometheus metrics for `GET /metrics` (ARCHITECTURE §4, §12), without a dependency: a
 * registry of counters, gauges and histograms rendered in the text exposition format.
 * Counters live in the process (they reset on restart, as Prometheus expects); gauges
 * that mirror live state are set by collectors at scrape time. Every component that
 * records anything takes a `Metrics` and defaults to a private one, so units stay
 * independent; the core hands one instance to all of them.
 */

export type Labels = Readonly<Record<string, string>>;

type MetricType = 'counter' | 'gauge' | 'histogram';

interface Metric {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly labelNames: readonly string[];
  /** Histograms only: the upper bounds, ascending, without `+Inf`. */
  readonly buckets: readonly number[];
  /** Keyed by the label values joined with `\u0000`. */
  readonly series: Map<string, Series>;
}

interface Series {
  readonly labels: Labels;
  value: number;
  /** Histograms: cumulative counts per bucket (same order as `buckets`), then sum in `value`. */
  counts: number[];
  count: number;
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatNumber(v: number): string {
  if (Number.isNaN(v)) {
    return 'NaN';
  }
  if (v === Number.POSITIVE_INFINITY) {
    return '+Inf';
  }
  if (v === Number.NEGATIVE_INFINITY) {
    return '-Inf';
  }
  return String(v);
}

function labelText(labels: Labels, extra?: [string, string]): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  if (extra !== undefined) {
    parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

export interface Counter {
  inc(labels?: Labels, by?: number): void;
}

export interface Gauge {
  set(labels: Labels | undefined, value: number): void;
  /** Drops every series, for collectors that re-set a label set on each scrape. */
  reset(): void;
}

export interface Histogram {
  observe(labels: Labels | undefined, value: number): void;
}

/** Seconds, from a few milliseconds to a long agent run. */
export const DURATION_BUCKETS: readonly number[] = [
  0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600,
];

/** A metric registry plus the exposition renderer; `Metrics` below names the daemon's. */
export class Registry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: (() => void)[] = [];

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    const m = this.define(name, 'counter', help, labelNames, []);
    return {
      inc: (labels, by = 1) => {
        if (by < 0) {
          throw new Error(`counter ${name} cannot decrease`);
        }
        this.series(m, labels).value += by;
      },
    };
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    const m = this.define(name, 'gauge', help, labelNames, []);
    return {
      set: (labels, value) => {
        this.series(m, labels).value = value;
      },
      reset: () => {
        m.series.clear();
      },
    };
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = DURATION_BUCKETS,
  ): Histogram {
    const sorted = [...buckets].sort((a, b) => a - b);
    const m = this.define(name, 'histogram', help, labelNames, sorted);
    return {
      observe: (labels, value) => {
        const s = this.series(m, labels);
        s.count += 1;
        s.value += value;
        // Stored per bucket, summed cumulatively at render time.
        const i = sorted.findIndex((bound) => value <= bound);
        if (i !== -1) {
          s.counts[i] = (s.counts[i] ?? 0) + 1;
        }
      },
    };
  }

  /** Runs before every `render`; the place to set gauges from live state. */
  collect(fn: () => void): void {
    this.collectors.push(fn);
  }

  /** The text exposition format (version 0.0.4), metrics in definition order. */
  render(): string {
    for (const fn of this.collectors) {
      fn();
    }
    const out: string[] = [];
    for (const m of this.metrics.values()) {
      out.push(`# HELP ${m.name} ${escapeHelp(m.help)}`, `# TYPE ${m.name} ${m.type}`);
      for (const s of m.series.values()) {
        if (m.type !== 'histogram') {
          out.push(`${m.name}${labelText(s.labels)} ${formatNumber(s.value)}`);
          continue;
        }
        let cumulative = 0;
        m.buckets.forEach((bound, i) => {
          cumulative += s.counts[i] ?? 0;
          out.push(
            `${m.name}_bucket${labelText(s.labels, ['le', formatNumber(bound)])} ${String(cumulative)}`,
          );
        });
        out.push(
          `${m.name}_bucket${labelText(s.labels, ['le', '+Inf'])} ${String(s.count)}`,
          `${m.name}_sum${labelText(s.labels)} ${formatNumber(s.value)}`,
          `${m.name}_count${labelText(s.labels)} ${String(s.count)}`,
        );
      }
    }
    return out.join('\n') + '\n';
  }

  /** The current value of one series (tests). Histograms report their count. */
  value(name: string, labels: Labels = {}): number | undefined {
    const m = this.metrics.get(name);
    const s = m?.series.get(this.key(m, labels));
    if (m === undefined || s === undefined) {
      return undefined;
    }
    return m.type === 'histogram' ? s.count : s.value;
  }

  private define(
    name: string,
    type: MetricType,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ): Metric {
    if (!NAME.test(name)) {
      throw new Error(`invalid metric name "${name}"`);
    }
    if (this.metrics.has(name)) {
      throw new Error(`metric "${name}" is already defined`);
    }
    for (const l of labelNames) {
      if (!NAME.test(l) || l.startsWith('__') || l === 'le') {
        throw new Error(`invalid label name "${l}" on ${name}`);
      }
    }
    const m: Metric = { name, type, help, labelNames, buckets, series: new Map() };
    this.metrics.set(name, m);
    return m;
  }

  private key(m: Metric, labels: Labels): string {
    return m.labelNames.map((l) => labels[l] ?? '').join('\u0000');
  }

  private series(m: Metric, labels: Labels | undefined): Series {
    const given = labels ?? {};
    for (const l of Object.keys(given)) {
      if (!m.labelNames.includes(l)) {
        throw new Error(`unknown label "${l}" on ${m.name}`);
      }
    }
    const key = this.key(m, given);
    let s = m.series.get(key);
    if (s === undefined) {
      const ordered: Record<string, string> = {};
      for (const l of m.labelNames) {
        ordered[l] = given[l] ?? '';
      }
      s = { labels: ordered, value: 0, counts: m.buckets.map(() => 0), count: 0 };
      m.series.set(key, s);
    }
    return s;
  }
}

/**
 * The daemon's metrics, `oa_` prefixed. Counters are incremented where the thing happens
 * (bus, dispatcher, executor, llm service, supervisor, scheduler, retention); the gauges
 * are set by `collect` callbacks the core registers at start.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly buildInfo = this.registry.gauge('oa_build_info', 'Always 1, labelled with the version', [
    'version',
  ]);
  readonly uptime = this.registry.gauge('oa_uptime_seconds', 'Seconds since the daemon started');
  readonly configTasks = this.registry.gauge('oa_config_tasks', 'Tasks in the active config');
  readonly configReloads = this.registry.counter(
    'oa_config_reloads_total',
    'Config reloads (SIGHUP, POST /v1/reload) by result',
    ['result'],
  );

  readonly eventsPublished = this.registry.counter(
    'oa_events_published_total',
    'Events published, by type ("other" unless the core or a task names it exactly) and whether they were inserted or dropped as duplicates',
    ['type', 'result'],
  );
  readonly eventsDropped = this.registry.counter(
    'oa_events_dropped_total',
    'Events the dispatcher dropped (causal chain deeper than limits.max_event_depth)',
    ['reason'],
  );
  readonly runsQueued = this.registry.counter('oa_runs_queued_total', 'Runs queued, by task', [
    'task',
  ]);
  readonly runAttempts = this.registry.counter(
    'oa_run_attempts_total',
    'Run attempts started (retries included), by task',
    ['task'],
  );
  readonly runsFinished = this.registry.counter(
    'oa_runs_finished_total',
    'Runs that reached succeeded or failed, by task and status',
    ['task', 'status'],
  );
  readonly runDuration = this.registry.histogram(
    'oa_run_duration_seconds',
    'Seconds from a run being queued to its terminal status, by task',
    ['task'],
  );
  readonly waitsEnded = this.registry.counter(
    'oa_waits_ended_total',
    'Waits that ended, by task and outcome (matched, timeout)',
    ['task', 'outcome'],
  );
  readonly runsPending = this.registry.gauge('oa_runs_pending', 'Runs queued for a worker');
  readonly runsInFlight = this.registry.gauge('oa_runs_in_flight', 'Runs executing now');
  readonly runsWaiting = this.registry.gauge(
    'oa_runs_waiting',
    'Runs parked in a wait for an event or a timeout',
  );
  readonly cronTicks = this.registry.counter(
    'oa_cron_ticks_total',
    'Cron ticks published, by task',
    ['task'],
  );
  readonly cronNextRun = this.registry.gauge(
    'oa_cron_next_run_timestamp_seconds',
    'Unix time of the next tick, by task',
    ['task'],
  );

  readonly modelCalls = this.registry.counter(
    'oa_model_calls_total',
    'Model calls ledgered (llm, decide and agent turns), by provider, model and task',
    ['provider', 'model', 'task'],
  );
  readonly modelTokens = this.registry.counter(
    'oa_model_tokens_total',
    'Tokens ledgered, by provider, model and direction (input, output, cache_read, cache_write)',
    ['provider', 'model', 'direction'],
  );
  readonly modelCost = this.registry.counter(
    'oa_model_cost_usd_total',
    'USD ledgered, by provider, model and task',
    ['provider', 'model', 'task'],
  );
  readonly budgetExceeded = this.registry.counter(
    'oa_budget_exceeded_total',
    'Calls refused or runs failed over a budget, by scope (daily, task)',
    ['scope'],
  );
  readonly spendToday = this.registry.gauge(
    'oa_model_spend_today_usd',
    'USD ledgered since 00:00 UTC',
  );
  readonly dailyBudget = this.registry.gauge(
    'oa_model_daily_budget_usd',
    'budgets.daily_usd from agent.yaml (absent when unset)',
  );

  readonly connectorUp = this.registry.gauge(
    'oa_connector_up',
    '1 when the connector process is up (a built-in is always up), by connector and transport',
    ['connector', 'transport'],
  );
  readonly connectorRestarts = this.registry.counter(
    'oa_connector_restarts_total',
    'Connector respawns scheduled after a crash or a failed start, by connector',
    ['connector'],
  );
  readonly connectorOps = this.registry.counter(
    'oa_connector_ops_total',
    'Connector ops called, by connector, op and result (ok, error)',
    ['connector', 'op', 'result'],
  );
  readonly connectorOpDuration = this.registry.histogram(
    'oa_connector_op_duration_seconds',
    'Seconds per connector op call',
    ['connector', 'op'],
  );
  readonly healthChecks = this.registry.counter(
    'oa_connector_health_checks_total',
    'Health checks (MCP ping) by connector and result (ok, failed)',
    ['connector', 'result'],
  );

  readonly retentionDeleted = this.registry.counter(
    'oa_retention_deleted_total',
    'Rows and directories removed by retention, by kind (events, runs, ledger, workspaces)',
    ['kind'],
  );
  readonly retentionRuns = this.registry.counter(
    'oa_retention_runs_total',
    'Retention passes, by result (ok, failed)',
    ['result'],
  );
  readonly retentionLastSuccess = this.registry.gauge(
    'oa_retention_last_success_timestamp_seconds',
    'Unix time of the last completed retention pass',
  );

  readonly dbSize = this.registry.gauge('oa_db_size_bytes', 'Size of the SQLite database');

  readonly apiRequests = this.registry.counter(
    'oa_api_requests_total',
    'API requests, by method and status',
    ['method', 'status'],
  );

  /** Registers a scrape-time collector; see `Registry.collect`. */
  collect(fn: () => void): void {
    this.registry.collect(fn);
  }

  render(): string {
    return this.registry.render();
  }
}
