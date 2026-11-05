import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { ConnectorConfig } from '../../config/connector.js';
import { errorMessage } from '../../errors.js';
import type { Logger } from '../../log.js';
import type { AcpAgent } from '../acp.js';
import type { OutputLimiter } from '../output.js';

/**
 * How the supervisor brings a connector up, by its manifest: `stdio` spawns an MCP server
 * on the child's pipes, `socket` reaches the MCP server a `managed_by: systemd` unit runs,
 * `acp` spawns an agent program, `process` spawns a `transport: none` program, and
 * `external` is a `managed_by: systemd` connector without ops, which nothing reaches.
 */
export type LauncherKind = 'stdio' | 'socket' | 'acp' | 'process' | 'external';

export function launcherKind(m: ConnectorConfig): LauncherKind {
  if (m.managed_by === 'systemd') {
    return m.transport === 'stdio' ? 'socket' : 'external';
  }
  return m.transport === 'stdio' ? 'stdio' : m.transport === 'acp' ? 'acp' : 'process';
}

/** One start of a connector, as the supervisor asks for it. */
export interface LaunchRequest {
  readonly manifest: ConnectorConfig;
  /** The child's whole environment, secrets rendered; throws when one cannot be. */
  env(): Record<string, string>;
  /** Already bound to the connector's name. */
  readonly log: Logger;
  /** A fresh one per process: its streams share the budget of logged lines (#91). */
  outputLimiter(): OutputLimiter;
  /** Aborting it stops what the launch began; the launch then settles once it has exited. */
  readonly signal: AbortSignal;
  /**
   * Whether the supervisor still wants this start: false once the core is stopping or the
   * connector was killed or replaced meanwhile. A launcher with a step before the spawn
   * (the acp proxy) checks it there and resolves `undefined`; the supervisor checks it again
   * on whatever a launch resolves and stops it.
   */
  wanted(): boolean;
}

/** A connector that is up: a process (or a unit's connection) and the client on top of it. */
export interface Launched {
  readonly pid: number | null;
  /** The MCP client of a connector that serves ops. */
  readonly client: Client | undefined;
  /** The ACP connection of an agent program. */
  readonly acp: AcpAgent | undefined;
  /**
   * Resolves with the reason once the process exits or the connection closes, however,
   * also after `stop`; the supervisor tells the two apart.
   */
  readonly ended: Promise<string>;
  /** Stops the process (or closes the connection) and resolves once it is gone. */
  stop(): Promise<void>;
}

/**
 * Starts one transport. Rejects with the reason the connector is down (the supervisor's
 * `error`); resolves `undefined` when the request stopped being wanted meanwhile.
 */
export interface Launcher {
  launch(req: LaunchRequest): Promise<Launched | undefined>;
}

/** The argv and environment of a spawned connector; throws the reasons it cannot be. */
export function childCommand(req: LaunchRequest): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  let env: Record<string, string>;
  try {
    env = req.env();
  } catch (err) {
    throw new Error(`cannot prepare environment: ${errorMessage(err)}`, { cause: err });
  }
  const [command, ...args] = req.manifest.exec ?? [];
  if (command === undefined) {
    throw new Error('exec is empty (a built-in connector is not spawned)');
  }
  return { command, args, env };
}
