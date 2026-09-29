import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { execa } from 'execa';

import { AgentDefaults, type AgentDefaultsConfig } from '../actions/agent-config.js';
import { NonRetryableError, type AgentClients, type ConnectorClients } from '../actions/types.js';
import type { ConnectorConfig, Transport } from '../config/connector.js';
import { parseDuration } from '../config/duration.js';
import { collectTemplateRefs, renderValue } from '../expr/template.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
import type { SecretsBackend } from '../secrets/secrets.js';
import type { JsonValue } from '../store/types.js';
import { VERSION } from '../version.js';
import type { AgentInfo, AgentSession, AgentSessionOptions } from './acp-types.js';
import { AcpAgent, pipeLines } from './acp.js';

export interface SupervisorOptions {
  manifests: readonly ConnectorConfig[];
  /** Passed to every connector as `OA_CORE_SOCKET`. */
  socketPath: string;
  secrets: SecretsBackend;
  log: Logger;
  /** Base environment for connector processes; defaults to a safe subset of the daemon's. */
  env?: Record<string, string>;
  /** Per-op default when the action names none. */
  callTimeoutMs?: number;
  /** `defaults.agent` and the workspace root for `agent` runs on acp connectors. */
  agents?: { defaults: AgentDefaultsConfig; workDir: string } | undefined;
  metrics?: Metrics | undefined;
}

export type ConnectorState = 'starting' | 'up' | 'down' | 'stopped';

/** The last health check of a connector with `health:` in its manifest. */
export interface ConnectorHealth {
  /** `null` until the first check after a (re)start. */
  ok: boolean | null;
  checked_at: string | null;
  /** Consecutive failures so far; `health.failures` of them respawn the process. */
  failures: number;
}

export interface ConnectorStatus {
  name: string;
  transport: Transport;
  state: ConnectorState;
  pid: number | null;
  restarts: number;
  /** Last spawn or transport error, if any. */
  error: string | null;
  /** `null` when the manifest has no `health:`. */
  health: ConnectorHealth | null;
}

/** What `apply` did to the set of connectors on a reload. */
export interface ApplyResult {
  added: string[];
  removed: string[];
  changed: string[];
}

/** The connector reported the op failed (`isError`), or the op is unknown to it. */
export class ConnectorOpError extends NonRetryableError {
  constructor(
    readonly connector: string,
    readonly op: string,
    message: string,
  ) {
    super(`${connector}.${op}: ${message}`);
    this.name = 'ConnectorOpError';
  }
}

/** The connector process is not up; retryable, since the supervisor restarts it. */
export class ConnectorDownError extends Error {
  constructor(readonly connector: string) {
    super(`connector "${connector}" is not running`);
    this.name = 'ConnectorDownError';
  }
}

/** How long a connector must stay up before its restart backoff resets. */
const STABLE_MS = 30_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A `transport: none` child: no MCP, just a process to watch and stop. */
interface PlainProcess {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
  /** Resolves when the process has exited, however. */
  readonly exited: Promise<void>;
}

interface Managed {
  readonly manifest: ConnectorConfig;
  state: ConnectorState;
  client: Client | undefined;
  transport: StdioClientTransport | undefined;
  /** A `none` child, or the `acp` agent (which is also a plain process to watch and stop). */
  process: PlainProcess | undefined;
  acp: AcpAgent | undefined;
  restarts: number;
  error: string | null;
  upSince: number;
  restartTimer: NodeJS.Timeout | undefined;
  healthTimer: NodeJS.Timeout | undefined;
  health: ConnectorHealth | null;
  /** Bumped by every `kill`, so a spawn still starting knows it was superseded. */
  epoch: number;
}

/** The manifest without its origin: two manifests that differ only in `file` are the same connector. */
export function manifestKey(m: ConnectorConfig): string {
  const { file: _file, ...rest } = m;
  return JSON.stringify(rest);
}

function newManaged(manifest: ConnectorConfig): Managed {
  return {
    manifest,
    state: 'stopped',
    client: undefined,
    transport: undefined,
    process: undefined,
    acp: undefined,
    restarts: 0,
    error: null,
    upSince: 0,
    restartTimer: undefined,
    healthTimer: undefined,
    health: manifest.health === undefined ? null : { ok: null, checked_at: null, failures: 0 },
    epoch: 0,
  };
}

/**
 * Connector supervisor (ARCHITECTURE §4, §6): spawns each configured connector, keeps one
 * MCP client per `stdio` connector and one ACP connection per `acp` connector, restarts
 * crashed processes with exponential backoff, and serves `op` calls and agent sessions to
 * the executor. Secrets named in a manifest's `config`/`env` are resolved at spawn time
 * and reach the child only through its environment.
 */
export class ConnectorSupervisor implements ConnectorClients, AgentClients {
  private agentDefaults: AgentDefaultsConfig;
  private agentWorkDir: string;
  private readonly managed = new Map<string, Managed>();
  private readonly socketPath: string;
  private readonly secrets: SecretsBackend;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private readonly baseEnv: Record<string, string>;
  private readonly callTimeoutMs: number;
  private stopping = false;

  constructor(opts: SupervisorOptions) {
    this.socketPath = opts.socketPath;
    this.secrets = opts.secrets;
    this.log = opts.log;
    this.metrics = opts.metrics ?? new Metrics();
    this.baseEnv = opts.env ?? getDefaultEnvironment();
    this.callTimeoutMs = opts.callTimeoutMs ?? 60_000;
    this.agentDefaults = opts.agents?.defaults ?? AgentDefaults.parse({});
    this.agentWorkDir = opts.agents?.workDir ?? join(tmpdir(), '247-agent', 'work');
    for (const manifest of opts.manifests) {
      this.managed.set(manifest.name, newManaged(manifest));
    }
  }

  get defaults(): AgentDefaultsConfig {
    return this.agentDefaults;
  }

  get workDir(): string {
    return this.agentWorkDir;
  }

  /** Reload seam: `defaults.agent` and `work_dir` for runs that start from now on. */
  configure(agents: { defaults: AgentDefaultsConfig; workDir: string }): void {
    this.agentDefaults = agents.defaults;
    this.agentWorkDir = agents.workDir;
  }

  /** The manifests currently supervised. */
  manifests(): ConnectorConfig[] {
    return [...this.managed.values()].map((m) => m.manifest);
  }

  names(): string[] {
    return [...this.managed.keys()];
  }

  agentNames(): string[] {
    return [...this.managed.values()]
      .filter((m) => m.manifest.transport === 'acp')
      .map((m) => m.manifest.name);
  }

  info(connector: string): AgentInfo | undefined {
    return this.managed.get(connector)?.acp?.info;
  }

  status(): ConnectorStatus[] {
    return [...this.managed.values()].map((m) => ({
      name: m.manifest.name,
      transport: m.manifest.transport,
      state: m.state,
      pid: m.transport?.pid ?? m.process?.pid ?? null,
      restarts: m.restarts,
      error: m.error,
      health: m.health === null ? null : { ...m.health },
    }));
  }

  async open(connector: string, opts: AgentSessionOptions): Promise<AgentSession> {
    const m = this.managed.get(connector);
    if (m === undefined) {
      throw new NonRetryableError(`unknown connector "${connector}"`);
    }
    if (m.manifest.transport !== 'acp') {
      throw new NonRetryableError(
        `connector "${connector}" is not an acp agent (transport ${m.manifest.transport})`,
      );
    }
    if (m.acp === undefined || m.state !== 'up') {
      throw new ConnectorDownError(connector);
    }
    return m.acp.openSession(opts);
  }

  /** Spawns every connector; a failed spawn is logged and retried with backoff. */
  async start(): Promise<void> {
    this.stopping = false;
    await Promise.all([...this.managed.values()].map((m) => this.spawn(m)));
  }

  /** Terminates every connector and waits for the processes to exit. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.managed.values()].map((m) => this.kill(m)));
  }

  /**
   * Reload seam (ARCHITECTURE §4): makes the supervised set match `manifests`. A connector
   * whose manifest is unchanged keeps running; a changed one is killed and respawned with
   * its new manifest and freshly resolved secrets; a removed one is stopped; a new one is
   * spawned. Ops on a connector being replaced fail as "not running" meanwhile.
   */
  async apply(manifests: readonly ConnectorConfig[]): Promise<ApplyResult> {
    const result: ApplyResult = { added: [], removed: [], changed: [] };
    const next = new Map(manifests.map((m) => [m.name, m]));
    const work: Promise<void>[] = [];
    for (const [name, m] of this.managed) {
      if (!next.has(name)) {
        result.removed.push(name);
        this.managed.delete(name);
        work.push(this.kill(m));
      }
    }
    for (const [name, manifest] of next) {
      const current = this.managed.get(name);
      if (current === undefined) {
        result.added.push(name);
        const m = newManaged(manifest);
        this.managed.set(name, m);
        work.push(this.spawn(m));
        continue;
      }
      if (manifestKey(current.manifest) === manifestKey(manifest)) {
        continue;
      }
      result.changed.push(name);
      const replacement = newManaged(manifest);
      this.managed.set(name, replacement);
      work.push(this.kill(current).then(() => this.spawn(replacement)));
    }
    await Promise.all(work);
    if (result.added.length + result.removed.length + result.changed.length > 0) {
      this.log.info('connector.set_applied', {
        added: result.added.length === 0 ? null : result.added.join(','),
        removed: result.removed.length === 0 ? null : result.removed.join(','),
        changed: result.changed.length === 0 ? null : result.changed.join(','),
      });
    }
    return result;
  }

  /**
   * Kills one connector and spawns it again, re-resolving its secrets: how a rotated
   * secret reaches a running connector (ARCHITECTURE §6). Deliberate, so the backoff
   * counter resets. Throws for an unknown name.
   */
  async restart(name: string): Promise<ConnectorStatus> {
    const m = this.managed.get(name);
    if (m === undefined) {
      throw new NonRetryableError(`unknown connector "${name}"`);
    }
    const log = this.log.child({ connector: name });
    log.info('connector.restart_requested', {});
    await this.kill(m);
    m.restarts = 0;
    if (!this.stopping && this.current(m)) {
      await this.spawn(m);
    }
    const status = this.status().find((s) => s.name === name);
    if (status === undefined) {
      throw new Error(`connector "${name}" was removed by a reload while restarting`);
    }
    return status;
  }

  async call(
    connector: string,
    op: string,
    args: Record<string, JsonValue>,
    opts: { signal: AbortSignal; timeoutMs?: number | undefined },
  ): Promise<JsonValue> {
    const m = this.managed.get(connector);
    if (m === undefined) {
      throw new NonRetryableError(`unknown connector "${connector}"`);
    }
    if (m.manifest.transport !== 'stdio') {
      throw new ConnectorOpError(connector, op, 'this connector serves no ops');
    }
    if (m.manifest.ops.length > 0 && !m.manifest.ops.includes(op)) {
      throw new ConnectorOpError(connector, op, "not in the manifest's ops");
    }
    if (m.client === undefined || m.state !== 'up') {
      throw new ConnectorDownError(connector);
    }
    const startedAt = Date.now();
    try {
      const result = await m.client.callTool({ name: op, arguments: args }, undefined, {
        signal: opts.signal,
        timeout: opts.timeoutMs ?? this.callTimeoutMs,
      });
      const value = toolResultToJson(connector, op, result);
      this.metrics.connectorOps.inc({ connector, op, result: 'ok' });
      return value;
    } catch (err) {
      this.metrics.connectorOps.inc({ connector, op, result: 'error' });
      throw err;
    } finally {
      this.metrics.connectorOpDuration.observe({ connector, op }, (Date.now() - startedAt) / 1000);
    }
  }

  private childEnv(m: Managed): Record<string, string> {
    const refs = collectTemplateRefs({ config: m.manifest.config, env: m.manifest.env });
    const secrets = this.secrets.resolve(refs.secrets);
    const scope = { secrets, env: this.baseEnv };
    const config = renderValue(m.manifest.config, scope);
    const env = renderValue(m.manifest.env, scope) as Record<string, string>;
    return {
      ...this.baseEnv,
      ...env,
      OA_CORE_SOCKET: this.socketPath,
      OA_CONNECTOR_NAME: m.manifest.name,
      OA_CONFIG_JSON: JSON.stringify(config),
    };
  }

  /** Whether `m` is still the supervised entry for its name (a reload may have replaced it). */
  private current(m: Managed): boolean {
    return this.managed.get(m.manifest.name) === m;
  }

  /**
   * Whether a spawn begun at `epoch` may still attach its process: not when the core is
   * stopping, `m` was killed meanwhile (stop, restart, a failed health check) or a reload
   * replaced or removed it.
   */
  private stillWanted(m: Managed, epoch: number): boolean {
    return !this.stopping && m.epoch === epoch && this.current(m);
  }

  private async spawn(m: Managed): Promise<void> {
    if (this.stopping || !this.current(m)) {
      return;
    }
    const log = this.log.child({ connector: m.manifest.name });
    const epoch = m.epoch;
    m.state = 'starting';
    m.error = null;
    let env: Record<string, string>;
    try {
      env = this.childEnv(m);
    } catch (err) {
      this.failed(m, `cannot prepare environment: ${errorMessage(err)}`, log);
      return;
    }
    const [command, ...args] = m.manifest.exec ?? [];
    if (command === undefined) {
      this.failed(m, 'exec is empty (a built-in connector is not spawned)', log);
      return;
    }
    const cwd = m.manifest.cwd;
    if (m.manifest.transport === 'none') {
      const child = execa(command, args, {
        ...(cwd === undefined ? {} : { cwd }),
        env,
        extendEnv: false,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        reject: false,
      });
      const proc: PlainProcess = {
        pid: child.pid,
        kill: (signal) => {
          child.kill(signal);
        },
        exited: child.then(
          (r) => {
            if (m.process !== proc) {
              return; // killed on purpose (stop/restart); not a crash
            }
            m.process = undefined;
            const why =
              r.exitCode === undefined
                ? `killed by ${r.signal ?? '?'}`
                : `exit code ${String(r.exitCode)}`;
            this.exited(m, why, log);
          },
          (err: unknown) => {
            if (m.process !== proc) {
              return;
            }
            m.process = undefined;
            this.exited(m, errorMessage(err), log);
          },
        ),
      };
      m.process = proc;
      pipeLines(child.stdout, 'stdout', log);
      pipeLines(child.stderr, 'stderr', log);
      this.up(m, log);
      return;
    }
    if (m.manifest.transport === 'acp') {
      let agent: AcpAgent;
      try {
        agent = await AcpAgent.spawn({ exec: [command, ...args], cwd, env, log });
      } catch (err) {
        if (this.stillWanted(m, epoch)) {
          this.failed(m, `cannot start: ${errorMessage(err)}`, log);
        }
        return;
      }
      if (!this.stillWanted(m, epoch)) {
        agent.kill('SIGTERM');
        return;
      }
      m.acp = agent;
      m.process = agent;
      void agent.exited.then(() => {
        if (m.process !== agent) {
          return; // killed on purpose (stop/restart); not a crash
        }
        m.process = undefined;
        m.acp = undefined;
        this.exited(m, 'process exited', log);
      });
      this.up(m, log);
      return;
    }
    const transport = new StdioClientTransport({
      command,
      args,
      env,
      ...(cwd === undefined ? {} : { cwd }),
      stderr: 'pipe',
    });
    const client = new Client({ name: '247-agent-core', version: VERSION });
    transport.onerror = (err) => {
      log.warn('connector.transport_error', { error: err.message });
    };
    pipeLines(transport.stderr as NodeJS.ReadableStream | null, 'stderr', log);
    try {
      await client.connect(transport);
    } catch (err) {
      await transport.close().catch(() => undefined);
      if (this.stillWanted(m, epoch)) {
        this.failed(m, `cannot start: ${errorMessage(err)}`, log);
      }
      return;
    }
    if (!this.stillWanted(m, epoch)) {
      await transport.close().catch(() => undefined);
      return;
    }
    m.client = client;
    m.transport = transport;
    transport.onclose = () => {
      if (m.transport !== transport) {
        return; // an older process; ignore
      }
      m.client = undefined;
      m.transport = undefined;
      this.exited(m, 'process exited', log);
    };
    this.up(m, log);
  }

  private up(m: Managed, log: Logger): void {
    m.state = 'up';
    m.upSince = Date.now();
    log.info('connector.up', {
      pid: m.transport?.pid ?? m.process?.pid ?? null,
      restarts: m.restarts,
    });
    if (m.health !== null) {
      m.health = { ok: null, checked_at: null, failures: 0 };
    }
    this.armHealth(m, log);
  }

  /** Schedules the next `ping` of a stdio connector with `health:`; checks never overlap. */
  private armHealth(m: Managed, log: Logger): void {
    const health = m.manifest.health;
    if (health === undefined || m.client === undefined || this.stopping) {
      return;
    }
    const client = m.client;
    m.healthTimer = setTimeout(() => {
      m.healthTimer = undefined;
      void this.checkHealth(m, client, log).then(() => {
        if (m.client === client && m.state === 'up') {
          this.armHealth(m, log);
        }
      });
    }, parseDuration(health.interval));
    m.healthTimer.unref();
  }

  private async checkHealth(m: Managed, client: Client, log: Logger): Promise<void> {
    const health = m.manifest.health;
    if (health === undefined || m.health === null) {
      return;
    }
    const startedAt = Date.now();
    let error: string | undefined;
    try {
      await client.ping({ timeout: parseDuration(health.timeout) });
    } catch (err) {
      error = errorMessage(err);
    }
    if (m.client !== client) {
      return; // the process changed under us; the new one has its own checks
    }
    const now = new Date().toISOString();
    if (error === undefined) {
      m.health = { ok: true, checked_at: now, failures: 0 };
      this.metrics.healthChecks.inc({ connector: m.manifest.name, result: 'ok' });
      log.debug('connector.health_ok', { duration_ms: Date.now() - startedAt });
      return;
    }
    const failures = m.health.failures + 1;
    m.health = { ok: false, checked_at: now, failures };
    this.metrics.healthChecks.inc({ connector: m.manifest.name, result: 'failed' });
    log.warn('connector.unhealthy', { error, failures, max_failures: health.failures });
    if (failures < health.failures) {
      return;
    }
    log.error('connector.health_failed', { failures });
    const epoch = m.epoch + 1; // the one this kill sets
    await this.kill(m);
    if (!this.current(m) || m.epoch !== epoch) {
      return; // a restart, a stop or a reload took over while the process was being killed
    }
    this.exited(m, `health checks failed ${String(failures)} times (${error})`, log);
  }

  private failed(m: Managed, error: string, log: Logger): void {
    m.error = error;
    m.state = 'down';
    log.error('connector.failed', { error });
    this.scheduleRestart(m, log);
  }

  private exited(m: Managed, why: string, log: Logger): void {
    if (this.stopping) {
      m.state = 'stopped';
      return;
    }
    if (Date.now() - m.upSince > STABLE_MS) {
      m.restarts = 0;
    }
    m.state = 'down';
    m.error = why;
    log.warn('connector.exited', { reason: why });
    this.scheduleRestart(m, log);
  }

  private scheduleRestart(m: Managed, log: Logger): void {
    if (this.stopping || m.restartTimer !== undefined) {
      return;
    }
    const base = parseDuration(m.manifest.restart.base);
    const max = parseDuration(m.manifest.restart.max);
    const delay = Math.min(base * 2 ** m.restarts, max);
    m.restarts++;
    this.metrics.connectorRestarts.inc({ connector: m.manifest.name });
    log.info('connector.restart_scheduled', { delay_ms: delay, restarts: m.restarts });
    m.restartTimer = setTimeout(() => {
      m.restartTimer = undefined;
      void this.spawn(m);
    }, delay);
    m.restartTimer.unref();
  }

  private async kill(m: Managed): Promise<void> {
    m.epoch++;
    if (m.restartTimer !== undefined) {
      clearTimeout(m.restartTimer);
      m.restartTimer = undefined;
    }
    if (m.healthTimer !== undefined) {
      clearTimeout(m.healthTimer);
      m.healthTimer = undefined;
    }
    m.state = 'stopped';
    const transport = m.transport;
    const child = m.process;
    m.client = undefined;
    m.transport = undefined;
    m.process = undefined;
    m.acp = undefined;
    if (transport !== undefined) {
      await transport.close().catch(() => undefined);
    }
    if (child?.pid !== undefined) {
      child.kill('SIGTERM');
      const done = await Promise.race([child.exited.then(() => true), sleep(5000, false)]);
      if (!done) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  }
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * An MCP tool result as a JSON value: `structuredContent` when the tool declares an output
 * schema, otherwise the text content (parsed as JSON when it is JSON, one string, or an
 * array of strings). An `isError` result fails the op with its text.
 */
export function toolResultToJson(connector: string, op: string, raw: unknown): JsonValue {
  const result = raw as ToolResult;
  const texts = (result.content ?? []).flatMap((c) =>
    c.type === 'text' && typeof c.text === 'string' ? [c.text] : [],
  );
  if (result.isError === true) {
    throw new ConnectorOpError(connector, op, texts.join('\n') || 'tool returned an error');
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent as JsonValue;
  }
  if (texts.length === 1) {
    const [text] = texts;
    if (text === undefined) {
      return null;
    }
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return texts.length === 0 ? null : texts;
}
