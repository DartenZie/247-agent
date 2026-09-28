/**
 * What an `agent` action sees of an ACP session (ARCHITECTURE §5.4): the protocol's
 * updates and permission requests, normalised so the runner and its tests never touch the
 * `@agentclientprotocol/sdk` types. `connectors/acp.ts` maps the wire shapes to these.
 */
import type { Logger } from '../log.js';

/** ACP `ToolKind`: what a tool call does, as the agent classifies it. */
export const TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** ACP `StopReason`: why a prompt turn ended. */
export type AgentStopReason =
  'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** One `session/update` notification, reduced to what the runner acts on. */
export type AgentUpdate =
  | { kind: 'text'; text: string; messageId: string | null }
  | { kind: 'thought' }
  | {
      kind: 'tool_call';
      id: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      /** `rawInput.command` when the agent sends one (a shell tool). */
      command: string | undefined;
      /** Paths the call touches, when reported. */
      locations: string[];
    }
  | {
      kind: 'tool_call_update';
      id: string;
      status: ToolCallStatus | undefined;
      /** Fields the update carries, when it does (agents often send `rawInput` late). */
      toolKind: ToolKind | undefined;
      command: string | undefined;
      locations: string[] | undefined;
    }
  | {
      kind: 'usage';
      /** Tokens in context and the context window, as reported. */
      used: number;
      size: number;
      /** Cumulative session cost in USD, when the agent reports one. */
      costUsd: number | undefined;
    }
  | { kind: 'other'; sessionUpdate: string };

/** The `session/prompt` response. `usage` is the SDK's experimental per-turn count. */
export interface AgentStop {
  stopReason: AgentStopReason;
  usage: { input: number; output: number } | undefined;
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

/** A `session/request_permission` request. */
export interface PermissionRequest {
  toolCall: {
    id: string;
    title: string;
    toolKind: ToolKind;
    command: string | undefined;
    locations: string[];
  };
  options: { optionId: string; kind: PermissionOptionKind }[];
}

/** The option id to select, or the literal `cancelled` (the protocol's other outcome). */
export const PERMISSION_CANCELLED = 'cancelled';

/** Answers a permission request with an option id, or `PERMISSION_CANCELLED`. */
export type PermissionHandler = (req: PermissionRequest) => string;

export interface AgentSessionOptions {
  /** Absolute path the session works in (the run's workspace). */
  cwd: string;
  onPermission: PermissionHandler;
  /** The run's signal; pending permission requests answer `cancelled` once it aborts. */
  signal: AbortSignal;
  log: Logger;
}

/** One ACP session on a live agent, as the runner drives it. */
export interface AgentSession {
  readonly sessionId: string;
  /** Yields the turn's updates, returns its stop. One turn at a time. */
  prompt(text: string): AsyncGenerator<AgentUpdate, AgentStop, undefined>;
  /** `session/cancel`; the running `prompt` then ends with `cancelled`. */
  cancel(): Promise<void>;
  /** Stops routing updates and permission requests for this session. */
  close(): void;
}

/** What an `agent` action knows about the connector that runs it (agent name and version). */
export interface AgentInfo {
  name: string;
  version: string | undefined;
}
