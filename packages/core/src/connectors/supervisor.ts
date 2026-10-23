import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { execa } from 'execa';

import { AgentDefaults, type AgentDefaultsConfig } from '../actions/agent-config.js';
import { netProxyDir } from '../actions/sandbox-net.js';
import { buildSandboxArgv, type SandboxBackend, type SandboxHost } from '../actions/sandbox.js';
import {
  NonRetryableError,
  OutcomeUnknownError,
  type AgentClients,
  type AgentOpenOptions,
  type ConnectorClients,
} from '../actions/types.js';
import {
  unitSocket,
  type ConnectorConfig,
  type Manager,
  type Transport,
} from '../config/connector.js';
import { parseDuration } from '../config/duration.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
import { killGroup, sweepGroupAfter } from '../process-group.js';
import type { SecretsBackend } from '../secrets/secrets.js';
import type { JsonValue } from '../store/types.js';
import { VERSION } from '../version.js';
import type { AgentInfo, AgentSession } from './acp-types.js';
import { AcpAgent, pipeLines } from './acp.js';
import { connectorBaseEnv, connectorChildEnv, sandboxOf } from './child-env.js';
import { openToolBridge, type ConnectorTools } from './mcp-bridge.js';
import { openNetProxy, type NetProxy } from './net-proxy.js';
import { SocketClientTransport } from './socket-transport.js';
import { ProcessClientTransport } from './stdio-transport.js';

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

/**
 * The home directory of a sandboxed agent program: inside `work_dir` (the one writable
 * path) and outside every run's workspace, so its caches and settings (`~/.npm`,
 * `~/.claude`) survive restarts and the retention sweep, which only takes `run_*` names.
 */
export function agentHome(workDir: string, connector: string): string {
  return join(workDir, 'home', connector);
}

function networkOf(m: ConnectorConfig): ConnectorNetwork {
  const network = sandboxOf(m)?.network;
  return network === undefined ? 'host' : network.allow.length === 0 ? 'none' : 'allowlist';
}

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
  /** A child's stdio, or the unit's socket for a `managed_by: systemd` connector. */
  transport: ProcessClientTransport | SocketClientTransport | undefined;
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
  /**
   * The spawn in flight, until its process is up or given up: its process is not on
   * `transport`/`process` yet, so `kill` aborts it and waits for it to stop.
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
  private readonly sandboxHost: SandboxHost | undefined;
  private readonly callTimeoutMs: number;
  /** Where the allowlist proxies listen (`netProxyDir`): made on first use, 0700. */
  private readonly netDir: string;
  private netSeq = 0;
  private readonly netProxies = new Set<NetProxy>();
  private stopping = false;
  /** The restart in flight per connector, which a concurrent `restart` joins. */
  private readonly restarting = new Map<string, Promise<ConnectorStatus>>();

  constructor(opts: SupervisorOptions) {
    this.socketPath = opts.socketPath;
    this.netDir = netProxyDir(opts.socketPath);
    this.secrets = opts.secrets;
    this.log = opts.log;
    this.metrics = opts.metrics ?? new Metrics();
    this.templateEnv = opts.templateEnv ?? opts.secrets.scrub(process.env);
    this.baseEnv = opts.env ?? connectorBaseEnv(this.templateEnv);
    this.sandboxHost = opts.sandboxHost;
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
    return this.managed.get(connector)?.acp?.info;
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
    const acp = m.acp;
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
    await Promise.all([...this.netProxies].map((p) => p.close()));
    try {
      // Each proxy removed its socket; the directory goes only if nothing else is in it.
      rmdirSync(this.netDir);
    } catch {
      // never made, or not empty
    }
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
   * Kills one connector and spawns it again, re-resolving its secrets: how a rotated
   * secret reaches a running connector (docs/internal/connectors.md). Deliberate, so the backoff
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
    if (m.client === undefined || m.state !== 'up') {
      throw new ConnectorDownError(connector);
    }
    return m.client;
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

  /**
   * The filtering proxy of a sandbox with a network allowlist (`connectors/net-proxy.ts`):
   * a socket in the daemon's runtime directory, which every sandbox masks and no bind may
   * show (`sandboxHost`, `checkSandboxes`), so no sandbox sees it unless bwrap binds it in
   * and one agent cannot borrow another's allowlist. The pid in the name keeps a second
   * daemon started on the same config, which fails only once it binds the core socket,
   * off this one's sockets. The caller closes it when the program is gone.
   */
  private async openNetProxy(m: Managed, allow: readonly string[], log: Logger): Promise<NetProxy> {
    if (!existsSync(this.netDir)) {
      // Not recursive: the runtime directory is the operator's to make, with its own mode.
      mkdirSync(this.netDir, { mode: 0o700 });
    }
    const connector = m.manifest.name;
    const proxy = await openNetProxy({
      allow,
      socket: join(this.netDir, `${String(process.pid)}-${String(++this.netSeq)}.sock`),
      log,
      onRequest: (result) => {
        this.metrics.sandboxNetRequests.inc({ connector, result });
      },
    });
    this.netProxies.add(proxy);
    return {
      socket: proxy.socket,
      close: () => {
        this.netProxies.delete(proxy);
        return proxy.close();
      },
    };
  }

  /**
   * How an acp agent is started: as it is, or as `bwrap … -- <exec>` with `work_dir`
   * writable, its home under it, the manifest's `cwd` (else that home) as cwd and the
   * agent's environment set inside; bwrap itself runs with the base environment, which
   * is where it is found on PATH. With `sandbox.network` the sandbox gets no network but
   * the proxy opened here for its `allow` list (none at all for an empty one).
   */
  private async agentSpawn(
    m: Managed,
    env: Record<string, string>,
    log: Logger,
  ): Promise<{
    exec: string[];
    cwd: string | undefined;
    env: Record<string, string>;
    proxy: NetProxy | undefined;
  }> {
    const exec = m.manifest.exec ?? [];
    const sandbox = sandboxOf(m.manifest);
    if (sandbox === undefined) {
      return { exec, cwd: m.manifest.cwd, env, proxy: undefined };
    }
    const home = agentHome(this.agentWorkDir, m.manifest.name);
    mkdirSync(home, { recursive: true });
    const allow = sandbox.network?.allow ?? [];
    const proxy = allow.length === 0 ? undefined : await this.openNetProxy(m, allow, log);
    return {
      exec: buildSandboxArgv({
        sandbox,
        cmd: exec,
        writable: this.agentWorkDir,
        cwd: m.manifest.cwd ?? home,
        home,
        env,
        host: this.sandboxHost,
        hostEnv: this.baseEnv,
        net: sandbox.network === undefined ? undefined : { proxySocket: proxy?.socket },
      }),
      cwd: undefined,
      env: this.baseEnv,
      proxy,
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
    if (m.manifest.managed_by === 'systemd') {
      await this.attach(m, epoch, signal, log);
      return;
    }
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
        // Logged line by line and dropped: a buffer would hit execa's maxBuffer and kill it.
        buffer: false,
        reject: false,
        // Its own process group, so a stop reaches what a wrapper started too (#196).
        detached: true,
      });
      const proc: PlainProcess = {
        pid: child.pid,
        kill: (signal) => {
          if (child.pid !== undefined) {
            killGroup(child.pid, signal);
          }
        },
        exited: sweepGroupAfter(child.pid, child)
          .then(() => child)
          .then(
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
      let proxy: NetProxy | undefined;
      try {
        const spawn = await this.agentSpawn(m, env, log);
        proxy = spawn.proxy;
        if (!this.stillWanted(m, epoch)) {
          // Stopped, killed or replaced while the proxy was opening: start nothing.
          void proxy?.close();
          return;
        }
        agent = await AcpAgent.spawn({
          exec: spawn.exec,
          cwd: spawn.cwd,
          env: spawn.env,
          log,
          signal,
        });
      } catch (err) {
        void proxy?.close();
        if (this.stillWanted(m, epoch)) {
          this.failed(m, `cannot start: ${errorMessage(err)}`, log);
        }
        return;
      }
      // The proxy serves this process alone: it goes when the process does, however.
      void agent.exited.then(() => proxy?.close());
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
    const transport = new ProcessClientTransport({
      command,
      args,
      env,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const client = new Client({ name: '247-agent-core', version: VERSION });
    transport.onerror = (err) => {
      log.warn('connector.transport_error', { error: err.message });
    };
    pipeLines(transport.stderr, 'stderr', log);
    try {
      await connectUntil(client, transport, signal);
    } catch (err) {
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
    // Chain, not replace: the client's own handler rejects the requests still in flight.
    const clientOnClose = transport.onclose;
    transport.onclose = () => {
      clientOnClose?.();
      if (m.transport !== transport) {
        return; // an older process; ignore
      }
      m.client = undefined;
      m.transport = undefined;
      this.exited(m, 'process exited', log);
    };
    this.up(m, log);
  }

  /**
   * A `managed_by: systemd` connector: its unit runs the process, so nothing is spawned and
   * no secret is resolved here. One without ops is `external`; one with ops is reached on
   * the unit's socket, reconnected with the restart backoff when the connection drops.
   */
  private async attach(m: Managed, epoch: number, signal: AbortSignal, log: Logger): Promise<void> {
    if (m.manifest.transport !== 'stdio') {
      m.state = 'external';
      log.info('connector.external', { unit: `247-agent-connector@${m.manifest.name}` });
      return;
    }
    const path = unitSocket(m.manifest);
    const transport = new SocketClientTransport(path);
    const client = new Client({ name: '247-agent-core', version: VERSION });
    transport.onerror = (err) => {
      log.warn('connector.transport_error', { error: err.message });
    };
    try {
      await connectUntil(client, transport, signal);
    } catch (err) {
      if (this.stillWanted(m, epoch)) {
        this.failed(
          m,
          `cannot connect to ${path} (is 247-agent-connector@${m.manifest.name} running?): ${errorMessage(err)}`,
          log,
        );
      }
      return;
    }
    if (!this.stillWanted(m, epoch)) {
      await transport.close().catch(() => undefined);
      return;
    }
    m.client = client;
    m.transport = transport;
    // Chain, not replace: the client's own handler rejects the ops in flight, which would
    // otherwise wait out their whole timeout on a connection that is gone.
    const clientOnClose = transport.onclose;
    transport.onclose = () => {
      clientOnClose?.();
      if (m.transport !== transport) {
        return; // an older connection; ignore
      }
      m.client = undefined;
      m.transport = undefined;
      this.exited(m, 'connection to the unit closed', log);
    };
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
    // Left set until the spawn settles, so a second kill waits for the same process.
    const starting = m.starting;
    const transport = m.transport;
    const child = m.process;
    m.client = undefined;
    m.transport = undefined;
    m.process = undefined;
    m.acp = undefined;
    if (starting !== undefined) {
      starting.abort.abort();
      await starting.done.catch(() => undefined);
    }
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

/**
 * `client.connect(transport)`, cut short by `signal`, which closes the transport. Rejects
 * on failure or abort only once the transport is closed, so a child it ran has exited.
 */
async function connectUntil(
  client: Client,
  transport: ProcessClientTransport | SocketClientTransport,
  signal: AbortSignal,
): Promise<void> {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= transport.close().catch(() => undefined));
  // The connect itself ends only when stdout closes, which a grandchild can hold open.
  let rejectAborted: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  aborted.catch(() => undefined);
  const onAbort = (): void => {
    void close().then(() => {
      rejectAborted(signal.reason);
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const connecting = client.connect(transport);
    connecting.catch(() => undefined);
    await Promise.race([connecting, aborted]);
    // `initialize` may have been answered just as the abort came.
    signal.throwIfAborted();
  } catch (err) {
    await close();
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function pidOf(m: Managed): number | null {
  const t = m.transport;
  return (t instanceof ProcessClientTransport ? t.pid : null) ?? m.process?.pid ?? null;
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
