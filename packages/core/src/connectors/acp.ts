/**
 * The core as an ACP client (Agent Client Protocol, agentclientprotocol.com; ARCHITECTURE
 * §5.4, §6). An `acp` connector is an agent program speaking JSON-RPC over stdio: the
 * supervisor spawns it once, `AcpAgent` initialises the connection, and every `agent` run
 * opens its own session with the workspace as `cwd`. Permission requests are routed by
 * session id to the run's policy; updates stream back through `AgentSession.prompt`.
 * This is the only module that imports the protocol SDK.
 */
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ClientConnection,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type ToolCallLocation,
  type ToolKind as WireToolKind,
} from '@agentclientprotocol/sdk';
import { execa } from 'execa';

import type { Logger } from '../log.js';
import {
  PERMISSION_CANCELLED,
  TOOL_KINDS,
  type AgentConfigOption,
  type AgentInfo,
  type AgentSession,
  type AgentSessionOptions,
  type AgentStop,
  type AgentUpdate,
  type PermissionHandler,
  type PermissionRequest,
  type ToolKind,
} from './acp-types.js';

export interface AcpSpawnOptions {
  /** argv of the agent program. */
  exec: readonly string[];
  cwd?: string | undefined;
  /** The whole environment of the child (secrets already rendered). */
  env: Record<string, string>;
  log: Logger;
  /** Reported to the agent as `clientInfo.version`. */
  version?: string | undefined;
  /** How long `initialize` may take before the spawn counts as failed. */
  initTimeoutMs?: number | undefined;
}

/** Bounds a spawn whose program never answers `initialize` (not an ACP agent, or hung). */
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

/** Logs each line of a child's stream as `connector.output` (the supervisor does the same for MCP children). */
export function pipeLines(
  stream: NodeJS.ReadableStream | null | undefined,
  name: string,
  log: Logger,
): void {
  if (stream === null || stream === undefined) {
    return;
  }
  const rl = createInterface({ input: stream });
  rl.on('line', (line) => {
    log.info('connector.output', { stream: name, line: line.slice(0, 2000) });
  });
}

interface Registered {
  onPermission: PermissionHandler;
  signal: AbortSignal;
}

function toolKind(kind: WireToolKind | null | undefined): ToolKind {
  return kind !== null && kind !== undefined && (TOOL_KINDS as readonly string[]).includes(kind)
    ? kind
    : 'other';
}

function commandOf(rawInput: unknown): string | undefined {
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return undefined;
  }
  const command = (rawInput as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

function locationsOf(locations: ToolCallLocation[] | null | undefined): string[] {
  return (locations ?? []).map((l) => l.path);
}

/** One `session/update` as the runner sees it (`acp-types.ts`). Exported for tests. */
export function normaliseUpdate(update: SessionUpdate): AgentUpdate {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content: ContentBlock = update.content;
      return {
        kind: 'text',
        text: content.type === 'text' ? content.text : `[${content.type}]`,
        messageId: update.messageId ?? null,
      };
    }
    case 'agent_thought_chunk': {
      const content: ContentBlock = update.content;
      return {
        kind: 'thought',
        text: content.type === 'text' ? content.text : `[${content.type}]`,
      };
    }
    case 'tool_call':
      return {
        kind: 'tool_call',
        id: update.toolCallId,
        title: update.title,
        toolKind: toolKind(update.kind),
        status: update.status ?? 'pending',
        command: commandOf(update.rawInput),
        locations: locationsOf(update.locations),
      };
    case 'tool_call_update':
      return {
        kind: 'tool_call_update',
        id: update.toolCallId,
        status: update.status ?? undefined,
        toolKind:
          update.kind === null || update.kind === undefined ? undefined : toolKind(update.kind),
        command: commandOf(update.rawInput),
        locations:
          update.locations === null || update.locations === undefined
            ? undefined
            : locationsOf(update.locations),
      };
    case 'usage_update':
      return {
        kind: 'usage',
        used: update.used,
        size: update.size,
        costUsd: update.cost?.amount,
      };
    default:
      return { kind: 'other', sessionUpdate: update.sessionUpdate };
  }
}

/** A `session/request_permission` as the policy sees it. Exported for tests. */
export function normalisePermission(req: RequestPermissionRequest): PermissionRequest {
  const call = req.toolCall;
  return {
    toolCall: {
      id: call.toolCallId,
      title: call.title ?? '',
      toolKind: toolKind(call.kind),
      command: commandOf(call.rawInput),
      locations: locationsOf(call.locations),
    },
    options: req.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
  };
}

/** `configOptions` as the runner sees them (`acp-types.ts`). Exported for tests. */
export function normaliseConfigOptions(
  options: readonly SessionConfigOption[] | null | undefined,
): AgentConfigOption[] {
  return (options ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    category: o.category ?? undefined,
    type: o.type,
    currentValue: o.currentValue,
    values:
      o.type === 'select'
        ? o.options.flatMap((v) => ('group' in v ? v.options.map((g) => g.value) : [v.value]))
        : [],
  }));
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

class AcpSession implements AgentSession {
  readonly sessionId: string;
  configOptions: readonly AgentConfigOption[];
  private closed = false;

  constructor(
    private readonly conn: ClientConnection,
    private readonly active: ActiveSession,
    private readonly unregister: () => void,
  ) {
    this.sessionId = active.sessionId;
    this.configOptions = normaliseConfigOptions(active.newSessionResponse.configOptions);
  }

  async setConfigOption(id: string, value: string): Promise<readonly AgentConfigOption[]> {
    if (this.closed) {
      throw new Error('session is closed');
    }
    const res = await this.conn.agent.request(methods.agent.session.setConfigOption, {
      sessionId: this.sessionId,
      configId: id,
      value,
    });
    this.configOptions = normaliseConfigOptions(res.configOptions);
    return this.configOptions;
  }

  async *prompt(text: string): AsyncGenerator<AgentUpdate, AgentStop, undefined> {
    if (this.closed) {
      throw new Error('session is closed');
    }
    // A rejected prompt also fails the update queue, which is where it surfaces.
    this.active.prompt(text).catch(() => undefined);
    for (;;) {
      const message = await this.active.nextUpdate();
      if (message.kind === 'stop') {
        const usage = message.response.usage;
        return {
          stopReason: message.stopReason,
          usage:
            usage === null || usage === undefined
              ? undefined
              : { input: usage.inputTokens, output: usage.outputTokens },
        };
      }
      if (message.update.sessionUpdate === 'config_option_update') {
        this.configOptions = normaliseConfigOptions(message.update.configOptions);
      }
      yield normaliseUpdate(message.update);
    }
  }

  cancel(): Promise<void> {
    return this.conn.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unregister();
    this.active.dispose();
  }
}

/**
 * One running ACP agent process with its initialised connection. `spawn` fails (and the
 * supervisor backs off) when the program exits, closes stdout or does not complete
 * `initialize` at protocol version 1 in time.
 */
export class AcpAgent {
  private constructor(
    readonly pid: number | undefined,
    /** Resolves when the process has exited, however. */
    readonly exited: Promise<void>,
    readonly info: AgentInfo,
    private readonly conn: ClientConnection,
    private readonly sessions: Map<string, Registered>,
    private readonly terminate: (signal: NodeJS.Signals) => void,
  ) {}

  static async spawn(opts: AcpSpawnOptions): Promise<AcpAgent> {
    const [command, ...args] = opts.exec;
    if (command === undefined) {
      throw new Error('exec is empty');
    }
    const child = execa(command, args, {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      env: opts.env,
      extendEnv: false,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
      reject: false,
    });
    const sessions = new Map<string, Registered>();
    const app = client({ name: '247-agent-core' }).onRequest(
      methods.client.session.requestPermission,
      (ctx) => {
        const params = ctx.params;
        const registered = sessions.get(params.sessionId);
        if (registered === undefined || registered.signal.aborted) {
          return CANCELLED;
        }
        const pick = registered.onPermission(normalisePermission(params));
        return pick === PERMISSION_CANCELLED
          ? CANCELLED
          : { outcome: { outcome: 'selected', optionId: pick } };
      },
    );
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const conn = app.connect(stream);
    pipeLines(child.stderr, 'stderr', opts.log);
    const exited: Promise<void> = child.then(
      () => undefined,
      () => undefined,
    );
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined) {
        child.kill(signal);
      }
    };
    const timeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const init = await Promise.race([
        conn.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: '247-agent', version: opts.version ?? '0' },
        }),
        exited.then(() => {
          throw new Error('the process exited before completing initialize');
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`no initialize response after ${String(timeoutMs)}ms`));
          }, timeoutMs);
        }),
      ]);
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `unsupported protocol version ${String(init.protocolVersion)} (this core speaks ${String(PROTOCOL_VERSION)})`,
        );
      }
      const info: AgentInfo = {
        name: init.agentInfo?.name ?? command,
        version: init.agentInfo?.version,
      };
      opts.log.info('connector.acp_initialized', {
        agent: info.name,
        agent_version: info.version ?? null,
        auth_methods: (init.authMethods ?? []).map((m) => m.id).join(','),
      });
      return new AcpAgent(child.pid, exited, info, conn, sessions, kill);
    } catch (err) {
      conn.close(err);
      kill('SIGKILL');
      // Stdout usually closes a moment before the exit is observed; say which it was.
      await Promise.race([exited, sleep(100)]);
      const code = child.exitCode;
      if (code !== null) {
        throw new Error(
          `the process exited with code ${String(code)} before completing initialize`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** Resolves when the connection closes (stdout ended or `kill()` was called). */
  get closed(): Promise<void> {
    return this.conn.closed;
  }

  kill(signal: NodeJS.Signals): void {
    this.conn.close();
    this.terminate(signal);
  }

  async openSession(opts: AgentSessionOptions): Promise<AgentSession> {
    const mcpServers = (opts.mcpServers ?? []).map((m) => ({
      name: m.name,
      command: m.command,
      args: m.args,
      env: Object.entries(m.env).map(([name, value]) => ({ name, value })),
    }));
    const active = await this.conn.agent.buildSession({ cwd: opts.cwd, mcpServers }).start();
    const id = active.sessionId;
    this.sessions.set(id, { onPermission: opts.onPermission, signal: opts.signal });
    opts.log.info('agent.session_opened', {
      session_id: id,
      agent: this.info.name,
      mcp_servers: mcpServers.length === 0 ? null : mcpServers.map((m) => m.name).join(','),
    });
    return new AcpSession(this.conn, active, () => {
      this.sessions.delete(id);
    });
  }
}
