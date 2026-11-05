import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { AgentDefaults, type AgentDefaultsConfig } from '../actions/agent-config.js';
import { netProxyDir } from '../actions/sandbox-net.js';
import type { SandboxBackend, SandboxHost } from '../actions/sandbox.js';
import {
  NonRetryableError,
  OutcomeUnknownError,
  type AgentClients,
  type AgentOpenOptions,
  type ConnectorClients,
} from '../actions/types.js';
import type { ConnectorConfig, Manager, Transport } from '../config/connector.js';
import { systemTimer, type SetTimer } from '../clock.js';
import { parseDuration } from '../config/duration.js';
import { errorMessage } from '../errors.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
import type { SecretsBackend } from '../secrets/secrets.js';
import type { JsonValue } from '../store/types.js';
import type { AgentInfo, AgentSession } from './acp-types.js';
import { connectorBaseEnv, connectorChildEnv, sandboxOf } from './child-env.js';
import { AcpLauncher } from './launchers/acp.js';
import {
  launcherKind,
  type Launched,
  type Launcher,
  type LauncherKind,
} from './launchers/index.js';
import { NetProxyPool } from './launchers/net-proxy-pool.js';
import { processLauncher } from './launchers/process.js';
import { socketLauncher } from './launchers/socket.js';
import { stdioLauncher } from './launchers/stdio.js';
import { openToolBridge, type ConnectorTools } from './mcp-bridge.js';
import { OutputLimiter } from './output.js';

export { agentHome } from './launchers/acp.js';

export interface SupervisorOptions {
  manifests: readonly ConnectorConfig[];
  /** Passed to every connector as `OA_CORE_SOCKET`. */
  socketPath: string;
  secrets: SecretsBackend;
  log: Logger;
  /** The `${env…}` scope of manifests: the daemon's environment, scrubbed (`ctx.childEnv`). */
  templateEnv?: Record<string, string>;
  /** Base environment for connector processes; defaults to `connectorBaseEnv(templateEnv)`. */
  env?: Record<string, string>;
  /** Per-op default when the action names none. */
  callTimeoutMs?: number;
  /** `defaults.agent` and the workspace root for `agent` runs on acp connectors. */
  agents?: { defaults: AgentDefaultsConfig; workDir: string } | undefined;
  /** What a sandboxed agent program must not see and must see (fixed for the process). */
  sandboxHost?: SandboxHost | undefined;
  metrics?: Metrics | undefined;
  /** Schedules restarts and health checks; defaults to `systemTimer`. */
  setTimer?: SetTimer | undefined;
}

/**
 * `external`: a `managed_by: systemd` connector without ops (`transport: none`); its own
 * unit runs it and the core has nothing to watch.
 */
export type ConnectorState = 'starting' | 'up' | 'down' | 'stopped' | 'external';

/**
 * What a connector process reaches: the `host`'s network (every unsandboxed one, and a
 * sandbox without `network`), `none`, or only its sandbox's `allowlist` through the
 * core's proxy.
 */
export type ConnectorNetwork = 'host' | 'none' | 'allowlist';

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
  /** `systemd` when the process runs in its own `247-agent-connector@<name>` unit. */
  managed_by: Manager;
  /** `bwrap` when the core runs this agent program in bubblewrap (acp only). */
  sandbox: SandboxBackend;
  /** `allowlist` or `none` when the sandbox has a `network` (acp only). */
  network: ConnectorNetwork;
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

/**
 * The `_meta` key of an `isError` result that marks the failure transient (the SDK's
 * `TRANSIENT_META_KEY`; docs/internal/connectors.md).
 */
export const TRANSIENT_META_KEY = 'oa/transient';

/**
 * The connector reported the op failed (`isError`), or the op is unknown to it. Final,
 * unless the connector marked the failure transient: a later call may succeed and
 * repeating the op is safe, so the run is retried by policy.
 */
export class ConnectorOpError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly connector: string,
    readonly op: string,
    message: string,
    opts: { transient?: boolean } = {},
  ) {
    super(`${connector}.${op}: ${message}`);
    this.name = 'ConnectorOpError';
    this.retryable = opts.transient === true;
  }
}

/** The connector process is not up; retryable, since the supervisor restarts it. */
export class ConnectorDownError extends Error {
  constructor(readonly connector: string) {
    super(`connector "${connector}" is not running`);
    this.name = 'ConnectorDownError';
  }
}

/**
 * The op was sent but no answer came: it timed out, the run's signal aborted it, or the
 * connector exited meanwhile. The connector may have done it or may still be doing it, so
 * the run is not retried (docs/internal/actions.md).
 */
export class ConnectorNoAnswerError extends OutcomeUnknownError {
  constructor(
    readonly connector: string,
    readonly op: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`${connector}.${op}: ${reason}; it may have taken effect`, options);
    this.name = 'ConnectorNoAnswerError';
  }
}

/** How long a connector must stay up before its restart backoff resets. */
const STABLE_MS = 30_000;

function networkOf(m: ConnectorConfig): ConnectorNetwork {
  const network = sandboxOf(m)?.network;
  return network === undefined ? 'host' : network.allow.length === 0 ? 'none' : 'allowlist';
}

interface Managed {
  readonly manifest: ConnectorConfig;
  state: ConnectorState;
  /** The process (or the unit's connection) while it is up, from its transport's launcher. */
  launched: Launched | undefined;
  restarts: number;
  error: string | null;
  upSince: number;
  /** Cancels the pending restart. */
  restartTimer: (() => void) | undefined;
  /** Cancels the pending health check. */
  healthTimer: (() => void) | undefined;
  health: ConnectorHealth | null;
  /** Bumped by every `kill`, so a spawn still starting knows it was superseded. */
  epoch: number;
  /**
   * The spawn in flight, until its process is up or given up: its process is not on
   * `launched` yet, so `kill` aborts it and waits for it to stop.
   */
  starting: { abort: AbortController; done: Promise<void> } | undefined;
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
    launched: undefined,
    restarts: 0,
    error: null,
    upSince: 0,
    restartTimer: undefined,
    healthTimer: undefined,
    health: manifest.health === undefined ? null : { ok: null, checked_at: null, failures: 0 },
    epoch: 0,
    starting: undefined,
  };
}

/**
 * Connector supervisor (docs/internal/architecture.md, docs/internal/connectors.md): spawns each configured connector, keeps one
 * MCP client per `stdio` connector and one ACP connection per `acp` connector, restarts
 * crashed processes with exponential backoff, and serves `op` calls and agent sessions to
 * the executor. Secrets named in a manifest's `config`/`env` are resolved at spawn time
 * and reach the child only through its environment.
 */
export class ConnectorSupervisor implements ConnectorClients, AgentClients, ConnectorTools {
  private agentDefaults: AgentDefaultsConfig;
  private agentWorkDir: string;
  private readonly managed = new Map<string, Managed>();
  private readonly socketPath: string;
  private readonly secrets: SecretsBackend;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private readonly baseEnv: Record<string, string>;
  private readonly templateEnv: Record<string, string>;
  private readonly callTimeoutMs: number;
  /** The allowlist proxies of sandboxed agents, under `netProxyDir`: made on first use, 0700. */
  private readonly netProxies: NetProxyPool;
  /** One per transport; `launcherKind` picks it from the manifest. */
  private readonly launchers: Record<Exclude<LauncherKind, 'external'>, Launcher>;
  private stopping = false;
  private readonly setTimer: SetTimer;
  /** The restart in flight per connector, which a concurrent `restart` joins. */
  private readonly restarting = new Map<string, Promise<ConnectorStatus>>();

  constructor(opts: SupervisorOptions) {
    this.socketPath = opts.socketPath;
    this.secrets = opts.secrets;
    this.log = opts.log;
    this.metrics = opts.metrics ?? new Metrics();
    this.templateEnv = opts.templateEnv ?? opts.secrets.scrub(process.env);
    this.baseEnv = opts.env ?? connectorBaseEnv(this.templateEnv);
    this.netProxies = new NetProxyPool({
      dir: netProxyDir(opts.socketPath),
      metrics: this.metrics,
    });
    this.launchers = {
      stdio: stdioLauncher,
      socket: socketLauncher,
      process: processLauncher,
      acp: new AcpLauncher({
        workDir: () => this.agentWorkDir,
        sandboxHost: opts.sandboxHost,
        hostEnv: this.baseEnv,
        proxies: this.netProxies,
      }),
    };
    this.callTimeoutMs = opts.callTimeoutMs ?? 60_000;
    this.setTimer = opts.setTimer ?? systemTimer;
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

  /**
   * Reload seam: `defaults.agent` and `work_dir` for runs that start from now on. A
   * sandboxed agent program has the old `work_dir` mounted as its only writable path, so
   * a new one respawns every such connector (with freshly resolved secrets, like
   * `restart`); the others are untouched.
   */
  async configure(agents: { defaults: AgentDefaultsConfig; workDir: string }): Promise<void> {
    const moved = agents.workDir !== this.agentWorkDir;
    this.agentDefaults = agents.defaults;
    this.agentWorkDir = agents.workDir;
    if (!moved) {
      return;
    }
    const affected = [...this.managed.values()].filter((m) => sandboxOf(m.manifest) !== undefined);
    await Promise.all(
      affected.map((m) => this.restart(m.manifest.name, 'work_dir changed').catch(() => undefined)),
    );
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
    return this.managed.get(connector)?.launched?.acp?.info;
  }

  status(): ConnectorStatus[] {
    return [...this.managed.values()].map((m) => ({
      name: m.manifest.name,
      transport: m.manifest.transport,
      managed_by: m.manifest.managed_by,
      sandbox: sandboxOf(m.manifest)?.backend ?? 'none',
      network: networkOf(m.manifest),
      state: m.state,
      pid: pidOf(m),
      restarts: m.restarts,
      error: m.error,
      health: m.health === null ? null : { ...m.health },
    }));
  }

  /**
   * Opens a session on an acp agent. With `tools` (the action's `mcp_servers`), a tool
   * bridge is opened for the session under `<work_dir>/.mcp` and offered to the agent as
   * its MCP servers; it closes with the session.
   */
  async open(connector: string, opts: AgentOpenOptions): Promise<AgentSession> {
    const m = this.managed.get(connector);
    if (m === undefined) {
      throw new NonRetryableError(`unknown connector "${connector}"`);
    }
    if (m.manifest.transport !== 'acp') {
      throw new NonRetryableError(
        `connector "${connector}" is not an acp agent (transport ${m.manifest.transport})`,
      );
    }
    const acp = m.launched?.acp;
    if (acp === undefined || m.state !== 'up') {
      throw new ConnectorDownError(connector);
    }
    const { tools = [], ...session } = opts;
    if (tools.length === 0) {
      return acp.openSession(session);
    }
    for (const grant of tools) {
      this.opsClient(grant.connector);
    }
    const bridge = await openToolBridge({
      grants: tools,
      tools: this,
      dir: join(this.agentWorkDir, '.mcp'),
      signal: opts.signal,
      log: opts.log,
    });
    let opened: AgentSession;
    try {
      opened = await acp.openSession({ ...session, mcpServers: bridge.servers });
    } catch (err) {
      await bridge.close();
      throw err;
    }
    return {
      sessionId: opened.sessionId,
      get configOptions() {
        return opened.configOptions;
      },
      setConfigOption: (id, value) => opened.setConfigOption(id, value),
      prompt: (text) => opened.prompt(text),
      cancel: () => opened.cancel(),
      close: () => {
        opened.close();
        void bridge.close();
      },
    };
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
    await this.netProxies.closeAll();
  }

  /**
   * Reload seam (docs/internal/architecture.md): makes the supervised set match `manifests`. A connector
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
      if (manifest.managed_by === 'systemd' && manifest.transport !== 'stdio') {
        // Nothing here reaches its process: the unit read the old manifest at its start.
        this.log.warn('connector.unit_restart_needed', {
          connector: name,
          unit: `247-agent-connector@${name}`,
        });
      }
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
   * Kills one connector and spawns it again, re-resolving its secrets: how a secret rotated
   * in the file backend reaches a running connector (docs/internal/connectors.md). Deliberate, so the backoff
   * counter resets. Throws for an unknown name. A restart requested while one is in flight
   * joins it: two would each spawn a process, and the one overwritten would never be stopped.
   */
  restart(name: string, reason = 'requested'): Promise<ConnectorStatus> {
    const inFlight = this.restarting.get(name);
    if (inFlight !== undefined) {
      this.log.child({ connector: name }).info('connector.restart_joined', { reason });
      return inFlight;
    }
    const p = this.restartOnce(name, reason).finally(() => {
      this.restarting.delete(name);
    });
    this.restarting.set(name, p);
    return p;
  }

  private async restartOnce(name: string, reason: string): Promise<ConnectorStatus> {
    const m = this.managed.get(name);
    if (m === undefined) {
      throw new NonRetryableError(`unknown connector "${name}"`);
    }
    const log = this.log.child({ connector: name });
    log.info('connector.restart_requested', { reason });
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
    return toolResultToJson(connector, op, await this.callTool(connector, op, args, opts));
  }

  /**
   * One op, its MCP result as returned (an `isError` result is counted as an error but not
   * thrown). The manifest's `ops` allowlist applies. Serves `call` and the tool bridge.
   */
  async callTool(
    connector: string,
    op: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; timeoutMs?: number | undefined },
  ): Promise<CallToolResult> {
    const m = this.managed.get(connector);
    if (
      m?.manifest.transport === 'stdio' &&
      m.manifest.ops.length > 0 &&
      !m.manifest.ops.includes(op)
    ) {
      throw new ConnectorOpError(connector, op, "not in the manifest's ops");
    }
    const client = this.opsClient(connector, op);
    // Aborted before the call is sent: the op never ran, so this stays retryable.
    opts.signal.throwIfAborted();
    const timeoutMs = opts.timeoutMs ?? this.callTimeoutMs;
    const startedAt = Date.now();
    try {
      const result = (await client.callTool({ name: op, arguments: args }, undefined, {
        signal: opts.signal,
        timeout: timeoutMs,
      })) as CallToolResult;
      this.metrics.connectorOps.inc({
        connector,
        op,
        result: result.isError === true ? 'error' : 'ok',
      });
      return result;
    } catch (err) {
      this.metrics.connectorOps.inc({ connector, op, result: 'error' });
      throw noAnswer(connector, op, err, opts.signal, timeoutMs) ?? err;
    } finally {
      this.metrics.connectorOpDuration.observe({ connector, op }, (Date.now() - startedAt) / 1000);
    }
  }

  /** The connector's tools that its manifest's `ops` let the core call (all of them for `ops: []`). */
  async listTools(connector: string, opts: { signal: AbortSignal }): Promise<Tool[]> {
    const client = this.opsClient(connector);
    const ops = this.managed.get(connector)?.manifest.ops ?? [];
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor }, {
        signal: opts.signal,
        timeout: this.callTimeoutMs,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return ops.length === 0 ? tools : tools.filter((t) => ops.includes(t.name));
  }

  /** The MCP client of a `stdio` connector that is up; throws the errors `call` documents. */
  private opsClient(connector: string, op = '*'): Client {
    const m = this.managed.get(connector);
    if (m === undefined) {
      throw new NonRetryableError(`unknown connector "${connector}"`);
    }
    if (m.manifest.transport !== 'stdio') {
      throw new ConnectorOpError(connector, op, 'this connector serves no ops');
    }
    const client = m.launched?.client;
    if (client === undefined || m.state !== 'up') {
      throw new ConnectorDownError(connector);
    }
    return client;
  }

  /** The child's environment, secrets rendered (docs/internal/connectors.md); see `connectorChildEnv`. */
  private childEnv(m: Managed): Record<string, string> {
    return connectorChildEnv({
      manifest: m.manifest,
      secrets: this.secrets,
      baseEnv: this.baseEnv,
      templateEnv: this.templateEnv,
      socketPath: this.socketPath,
    });
  }

  /** Whether `m` is still the supervised entry for its name (a reload may have replaced it). */
  private current(m: Managed): boolean {
    return this.managed.get(m.manifest.name) === m;
  }

  /** One per process: its streams share the budget of logged output lines (#91). */
  private outputLimiter(connector: string): OutputLimiter {
    return new OutputLimiter({
      onDrop: (lines) => {
        this.metrics.connectorOutputDropped.inc({ connector }, lines);
      },
    });
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
    const abort = new AbortController();
    const starting = { abort, done: this.spawnOnce(m, abort.signal) };
    m.starting = starting;
    try {
      await starting.done;
    } finally {
      if (m.starting === starting) {
        m.starting = undefined;
      }
    }
  }

  /** One start; aborting `signal` stops the process it began and resolves once it has exited. */
  private async spawnOnce(m: Managed, signal: AbortSignal): Promise<void> {
    if (this.stopping || !this.current(m)) {
      return;
    }
    const log = this.log.child({ connector: m.manifest.name });
    const epoch = m.epoch;
    m.state = 'starting';
    m.error = null;
    const kind = launcherKind(m.manifest);
    if (kind === 'external') {
      // Its own unit runs it and the core has nothing to reach.
      m.state = 'external';
      log.info('connector.external', { unit: `247-agent-connector@${m.manifest.name}` });
      return;
    }
    let launched: Launched | undefined;
    try {
      launched = await this.launchers[kind].launch({
        manifest: m.manifest,
        env: () => this.childEnv(m),
        log,
        outputLimiter: () => this.outputLimiter(m.manifest.name),
        signal,
        wanted: () => this.stillWanted(m, epoch),
      });
    } catch (err) {
      if (this.stillWanted(m, epoch)) {
        this.failed(m, errorMessage(err), log);
      }
      return;
    }
    if (launched === undefined) {
      return;
    }
    if (!this.stillWanted(m, epoch)) {
      // Stopped, killed or replaced while it was starting.
      await launched.stop();
      return;
    }
    m.launched = launched;
    const up = launched;
    void up.ended.then((why) => {
      if (m.launched !== up) {
        return; // killed on purpose (stop/restart), or an older process; not a crash
      }
      m.launched = undefined;
      this.exited(m, why, log);
    });
    this.up(m, log);
  }

  private up(m: Managed, log: Logger): void {
    m.state = 'up';
    m.upSince = Date.now();
    log.info('connector.up', {
      pid: pidOf(m),
      restarts: m.restarts,
      sandbox: sandboxOf(m.manifest)?.backend ?? 'none',
      network: networkOf(m.manifest),
    });
    if (m.health !== null) {
      m.health = { ok: null, checked_at: null, failures: 0 };
    }
    this.armHealth(m, log);
  }

  /** Schedules the next `ping` of a stdio connector with `health:`; checks never overlap. */
  private armHealth(m: Managed, log: Logger): void {
    const health = m.manifest.health;
    const client = m.launched?.client;
    if (health === undefined || client === undefined || this.stopping) {
      return;
    }
    m.healthTimer = this.setTimer(() => {
      m.healthTimer = undefined;
      void this.checkHealth(m, client, log).then(() => {
        if (m.launched?.client === client && m.state === 'up') {
          this.armHealth(m, log);
        }
      });
    }, parseDuration(health.interval));
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
    if (m.launched?.client !== client) {
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
    m.restartTimer = this.setTimer(() => {
      m.restartTimer = undefined;
      void this.spawn(m);
    }, delay);
  }

  private async kill(m: Managed): Promise<void> {
    m.epoch++;
    if (m.restartTimer !== undefined) {
      m.restartTimer();
      m.restartTimer = undefined;
    }
    if (m.healthTimer !== undefined) {
      m.healthTimer();
      m.healthTimer = undefined;
    }
    m.state = 'stopped';
    // Left set until the spawn settles, so a second kill waits for the same process.
    const starting = m.starting;
    const launched = m.launched;
    m.launched = undefined;
    if (starting !== undefined) {
      starting.abort.abort();
      await starting.done.catch(() => undefined);
    }
    await launched?.stop();
  }
}

function pidOf(m: Managed): number | null {
  return m.launched?.pid ?? null;
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * An MCP tool result as a JSON value: `structuredContent` when the tool declares an output
 * schema, otherwise the text content (parsed as JSON when it is JSON, one string, or an
 * array of strings). An `isError` result fails the op with its text, retryably when its
 * `_meta` marks it transient.
 */
export function toolResultToJson(connector: string, op: string, raw: unknown): JsonValue {
  const result = raw as ToolResult;
  const texts = (result.content ?? []).flatMap((c) =>
    c.type === 'text' && typeof c.text === 'string' ? [c.text] : [],
  );
  if (result.isError === true) {
    throw new ConnectorOpError(connector, op, texts.join('\n') || 'tool returned an error', {
      transient: result._meta?.[TRANSIENT_META_KEY] === true,
    });
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

// The errors the MCP client raises itself; a server may answer with the same codes for
// errors of its own, which are answers.
const TIMED_OUT = new McpError(ErrorCode.RequestTimeout, 'Request timed out').message;
const CLOSED = new McpError(ErrorCode.ConnectionClosed, 'Connection closed').message;

/**
 * `ConnectorNoAnswerError` for a call that was sent and got no answer, else `undefined`.
 * The MCP client has already sent `notifications/cancelled` for a timeout or an abort.
 */
function noAnswer(
  connector: string,
  op: string,
  err: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): ConnectorNoAnswerError | undefined {
  if (signal.aborted) {
    const why = signal.reason instanceof Error ? signal.reason.message : 'aborted';
    return new ConnectorNoAnswerError(connector, op, `cut off (${why})`, { cause: err });
  }
  if (err instanceof McpError && err.message === TIMED_OUT) {
    return new ConnectorNoAnswerError(connector, op, `timed out after ${String(timeoutMs)} ms`, {
      cause: err,
    });
  }
  if (err instanceof McpError && err.message === CLOSED) {
    return new ConnectorNoAnswerError(connector, op, 'the connector exited before answering', {
      cause: err,
    });
  }
  return undefined;
}
