import { createInterface } from 'node:readline';
import type { Stream } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { execa } from 'execa';

import { NonRetryableError, type ConnectorClients } from '../actions/types.js';
import type { ConnectorConfig } from '../config/connector.js';
import { parseDuration } from '../config/duration.js';
import { collectTemplateRefs, renderValue } from '../expr/template.js';
import type { Logger } from '../log.js';
import type { SecretsBackend } from '../secrets/secrets.js';
import type { JsonValue } from '../store/types.js';

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
}

export type ConnectorState = 'starting' | 'up' | 'down' | 'stopped';

export interface ConnectorStatus {
  name: string;
  state: ConnectorState;
  pid: number | null;
  restarts: number;
  /** Last spawn or transport error, if any. */
  error: string | null;
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
  process: PlainProcess | undefined;
  restarts: number;
  error: string | null;
  upSince: number;
  restartTimer: NodeJS.Timeout | undefined;
}

/**
 * Connector supervisor (ARCHITECTURE §4, §6): spawns each configured connector, keeps one
 * MCP client per `stdio` connector, restarts crashed processes with exponential backoff
 * and serves `op` calls to the executor. Secrets named in a manifest's `config`/`env` are
 * resolved at spawn time and reach the child only through its environment.
 */
export class ConnectorSupervisor implements ConnectorClients {
  private readonly managed = new Map<string, Managed>();
  private readonly socketPath: string;
  private readonly secrets: SecretsBackend;
  private readonly log: Logger;
  private readonly baseEnv: Record<string, string>;
  private readonly callTimeoutMs: number;
  private stopping = false;

  constructor(opts: SupervisorOptions) {
    this.socketPath = opts.socketPath;
    this.secrets = opts.secrets;
    this.log = opts.log;
    this.baseEnv = opts.env ?? getDefaultEnvironment();
    this.callTimeoutMs = opts.callTimeoutMs ?? 60_000;
    for (const manifest of opts.manifests) {
      this.managed.set(manifest.name, {
        manifest,
        state: 'stopped',
        client: undefined,
        transport: undefined,
        process: undefined,
        restarts: 0,
        error: null,
        upSince: 0,
        restartTimer: undefined,
      });
    }
  }

  names(): string[] {
    return [...this.managed.keys()];
  }

  status(): ConnectorStatus[] {
    return [...this.managed.values()].map((m) => ({
      name: m.manifest.name,
      state: m.state,
      pid: m.transport?.pid ?? m.process?.pid ?? null,
      restarts: m.restarts,
      error: m.error,
    }));
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
    if (!this.stopping) {
      await this.spawn(m);
    }
    const status = this.status().find((s) => s.name === name);
    if (status === undefined) {
      throw new Error(`connector "${name}" vanished`); // unreachable: managed never shrinks
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
    if (m.manifest.transport === 'none') {
      throw new ConnectorOpError(connector, op, 'this connector serves no ops');
    }
    if (m.manifest.ops.length > 0 && !m.manifest.ops.includes(op)) {
      throw new ConnectorOpError(connector, op, "not in the manifest's ops");
    }
    if (m.client === undefined || m.state !== 'up') {
      throw new ConnectorDownError(connector);
    }
    const result = await m.client.callTool({ name: op, arguments: args }, undefined, {
      signal: opts.signal,
      timeout: opts.timeoutMs ?? this.callTimeoutMs,
    });
    return toolResultToJson(connector, op, result);
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

  private async spawn(m: Managed): Promise<void> {
    if (this.stopping) {
      return;
    }
    const log = this.log.child({ connector: m.manifest.name });
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
      this.pipeLines(child.stdout, 'stdout', log);
      this.pipeLines(child.stderr, 'stderr', log);
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
    const client = new Client({ name: '247-agent-core', version: '0' });
    transport.onerror = (err) => {
      log.warn('connector.transport_error', { error: err.message });
    };
    this.pipeLines(transport.stderr, 'stderr', log);
    try {
      await client.connect(transport);
    } catch (err) {
      await transport.close().catch(() => undefined);
      this.failed(m, `cannot start: ${errorMessage(err)}`, log);
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

  private pipeLines(stream: Stream | null | undefined, name: string, log: Logger): void {
    if (stream === null || stream === undefined) {
      return;
    }
    const rl = createInterface({ input: stream as unknown as NodeJS.ReadableStream });
    rl.on('line', (line) => {
      log.info('connector.output', { stream: name, line: line.slice(0, 2000) });
    });
  }

  private up(m: Managed, log: Logger): void {
    m.state = 'up';
    m.upSince = Date.now();
    log.info('connector.up', {
      pid: m.transport?.pid ?? m.process?.pid ?? null,
      restarts: m.restarts,
    });
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
    log.info('connector.restart_scheduled', { delay_ms: delay, restarts: m.restarts });
    m.restartTimer = setTimeout(() => {
      m.restartTimer = undefined;
      void this.spawn(m);
    }, delay);
    m.restartTimer.unref();
  }

  private async kill(m: Managed): Promise<void> {
    if (m.restartTimer !== undefined) {
      clearTimeout(m.restartTimer);
      m.restartTimer = undefined;
    }
    m.state = 'stopped';
    const transport = m.transport;
    const child = m.process;
    m.client = undefined;
    m.transport = undefined;
    m.process = undefined;
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
