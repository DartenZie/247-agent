import { describe, expect, it } from 'vitest';

import type { DispatcherHealth } from './bus/dispatcher.js';
import type { ConnectorState, ConnectorStatus } from './connectors/supervisor.js';
import type { Core } from './core.js';
import { checkHealth } from './health.js';

const NOW = new Date('2026-10-24T08:00:00.000Z');

function connector(name: string, state: ConnectorState, ok?: boolean): ConnectorStatus {
  return {
    name,
    transport: 'stdio',
    managed_by: 'core',
    sandbox: 'none',
    network: 'host',
    state,
    pid: null,
    restarts: 0,
    error: null,
    health: ok === undefined ? null : { ok, checked_at: null, failures: ok ? 0 : 1 },
  };
}

function core(
  opts: {
    connectors?: ConnectorStatus[];
    pollers?: number;
    dispatcher?: DispatcherHealth;
    probe?: () => void;
  } = {},
): Core {
  return {
    bus: {
      dispatcher: {
        health: () => opts.dispatcher ?? { ok: true, error: null, failing_since: null },
      },
    },
    store: { probeWrite: opts.probe ?? (() => undefined) },
    supervisor: opts.connectors === undefined ? undefined : { status: () => opts.connectors ?? [] },
    pollers: Array.from({ length: opts.pollers ?? 0 }, () => ({})),
  } as unknown as Core;
}

describe('checkHealth', () => {
  it('is ok with every check passing, and with no connector at all', () => {
    expect(checkHealth(core(), NOW)).toEqual({
      status: 'ok',
      dispatcher: { status: 'ok', error: null, failing_since: null },
      database: { status: 'ok', error: null },
      connectors: { status: 'ok', up: 0, total: 0, down: [] },
    });
  });

  it('counts pollers and external connectors as up', () => {
    const h = checkHealth(core({ connectors: [connector('hook', 'external')], pollers: 1 }), NOW);
    expect(h.connectors).toEqual({ status: 'ok', up: 2, total: 2, down: [] });
  });

  it('is degraded with some connectors down, failing health pings or starting', () => {
    const h = checkHealth(
      core({
        connectors: [
          connector('mail', 'up'),
          connector('chat', 'down'),
          connector('jira', 'up', false),
          connector('ftp', 'starting'),
        ],
      }),
      NOW,
    );
    expect(h.status).toBe('degraded');
    expect(h.connectors).toEqual({ status: 'degraded', up: 1, total: 4, down: ['chat', 'jira'] });
  });

  it('is failing when no connector is up, but not while one is starting', () => {
    const down = [connector('mail', 'down'), connector('chat', 'stopped')];
    expect(checkHealth(core({ connectors: down }), NOW).status).toBe('failing');
    const starting = [connector('mail', 'down'), connector('chat', 'starting')];
    expect(checkHealth(core({ connectors: starting }), NOW).status).toBe('degraded');
  });

  it('is failing when the dispatcher fails or the database refuses a commit', () => {
    const dispatcher = { ok: false, error: 'disk full', failing_since: NOW.toISOString() };
    expect(checkHealth(core({ dispatcher }), NOW)).toMatchObject({
      status: 'failing',
      dispatcher: { status: 'failing', error: 'disk full', failing_since: NOW.toISOString() },
    });
    const probe = () => {
      throw new Error('attempt to write a readonly database');
    };
    expect(checkHealth(core({ probe }), NOW)).toMatchObject({
      status: 'failing',
      database: { status: 'failing', error: 'attempt to write a readonly database' },
    });
  });
});
