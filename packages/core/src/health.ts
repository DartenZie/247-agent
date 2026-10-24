import type { Core } from './core.js';

/**
 * What `GET /v1/health` and `oa health` report (docs/internal/architecture.md). `failing`
 * means the daemon cannot do its job: the dispatcher's last pass threw, the database
 * refused a commit, or no connector is up. `degraded` means it works with less: some
 * connectors are down or failing their health checks.
 */
export type HealthStatus = 'ok' | 'degraded' | 'failing';

export interface DispatcherCheck {
  status: 'ok' | 'failing';
  error: string | null;
  failing_since: string | null;
}

export interface DatabaseCheck {
  status: 'ok' | 'failing';
  error: string | null;
}

export interface ConnectorsCheck {
  status: HealthStatus;
  /** Connectors up, built-in pollers and `external` ones (their own unit) included. */
  up: number;
  total: number;
  /** Down, stopped or failing their `health:` pings, by name. */
  down: string[];
}

export interface HealthChecks {
  status: HealthStatus;
  dispatcher: DispatcherCheck;
  database: DatabaseCheck;
  connectors: ConnectorsCheck;
}

const RANK: Record<HealthStatus, number> = { ok: 0, degraded: 1, failing: 2 };

function worst(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
}

function checkDatabase(core: Core, now: Date): DatabaseCheck {
  try {
    core.store.probeWrite(now.getTime());
    return { status: 'ok', error: null };
  } catch (err) {
    return { status: 'failing', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A connector on its first spawn (`starting`, no restarts yet) counts as neither up nor
 * down, so a daemon that just started is `degraded` rather than `failing`. A respawn
 * counts as down, so a crash-looping connector does not flip the report between the two.
 */
function checkConnectors(core: Core): ConnectorsCheck {
  let up = core.pollers.length;
  let starting = 0;
  const down: string[] = [];
  const processes = core.supervisor?.status() ?? [];
  for (const c of processes) {
    if (c.state === 'starting' && c.restarts === 0) {
      starting++;
    } else if ((c.state === 'up' || c.state === 'external') && c.health?.ok !== false) {
      up++;
    } else {
      down.push(c.name);
    }
  }
  const total = processes.length + core.pollers.length;
  let status: HealthStatus = 'ok';
  if (total > 0 && up === 0 && starting === 0) {
    status = 'failing';
  } else if (down.length > 0 || starting > 0) {
    status = 'degraded';
  }
  return { status, up, total, down };
}

/** Runs every check; the database one commits a single row, the rest read memory. */
export function checkHealth(core: Core, now: Date): HealthChecks {
  const d = core.bus.dispatcher.health();
  const dispatcher: DispatcherCheck = {
    status: d.ok ? 'ok' : 'failing',
    error: d.error,
    failing_since: d.failing_since,
  };
  const database = checkDatabase(core, now);
  const connectors = checkConnectors(core);
  return {
    status: worst([dispatcher.status, database.status, connectors.status]),
    dispatcher,
    database,
    connectors,
  };
}
