import { isInside } from '../config/crosscheck.js';
import {
  PERMISSION_CANCELLED,
  type PermissionOptionKind,
  type PermissionRequest,
  type ToolKind,
} from '../connectors/acp-types.js';

/**
 * What an `agent` action lets its ACP agent do (ARCHITECTURE §5.4, §11): the tool kinds
 * in `tools`, shell commands that start with a `bash_allow` entry, and paths inside the
 * workspace. Everything else is refused when the agent asks.
 */
export interface AgentPolicy {
  tools: readonly ToolKind[];
  bashAllow: readonly string[];
  workspace: string;
}

/** `optionId` is what to answer: an offered option, or `PERMISSION_CANCELLED`. */
export type PermissionDecision =
  { allow: true; optionId: string } | { allow: false; optionId: string; reason: string };

/**
 * Shell syntax that would run something other than the allowed program: command
 * separators and chaining, pipes, background, redirections, substitutions, line breaks.
 * Quoting does not exempt it (`-m "a; b"` is refused too): the core does not parse shell.
 */
const SHELL_OPERATORS = /[;&|<>`\n\r]|\$\(|\$\{/;

/**
 * True when `command` is an `allow` entry itself, or starts with one followed by whitespace
 * and contains no shell operators. Only an exact entry can therefore carry `&&`, `|`, `$(`
 * and the like, so `bash_allow: ["npm run build"]` never admits `npm run build && curl …`.
 */
export function commandAllowed(command: string, allow: readonly string[]): boolean {
  const c = command.trim();
  if (allow.includes(c)) {
    return true;
  }
  if (SHELL_OPERATORS.test(c)) {
    return false;
  }
  return allow.some((p) => c.startsWith(p + ' ') || c.startsWith(p + '\t'));
}

function pick(
  options: PermissionRequest['options'],
  kinds: readonly PermissionOptionKind[],
): string | undefined {
  for (const kind of kinds) {
    const o = options.find((x) => x.kind === kind);
    if (o !== undefined) {
      return o.optionId;
    }
  }
  return undefined;
}

/** A tool call as far as the policy can judge it; `command` is unknown when the agent sent none. */
export interface JudgedCall {
  toolKind: ToolKind;
  command: string | undefined;
  locations: readonly string[];
}

/**
 * Why `call` falls outside the policy, or undefined when it does not. An `execute` call
 * without a known command cannot be judged on its command (only on its kind and paths).
 */
export function policyViolation(policy: AgentPolicy, call: JudgedCall): string | undefined {
  if (!policy.tools.includes(call.toolKind)) {
    return `tool kind "${call.toolKind}" is not in tools`;
  }
  if (
    call.toolKind === 'execute' &&
    call.command !== undefined &&
    !commandAllowed(call.command, policy.bashAllow)
  ) {
    return `command is not in bash_allow: ${call.command.slice(0, 200)}`;
  }
  const outside = call.locations.find((p) => !isInside(policy.workspace, p));
  return outside === undefined ? undefined : `path outside the workspace: ${outside}`;
}

/**
 * Answers a `session/request_permission`. Allowed calls get `allow_once` (never
 * `allow_always`: every call is judged); refused ones `reject_once`, then `reject_always`,
 * then the protocol's `cancelled` outcome when the agent offers no reject option. An
 * `execute` request without `rawInput.command` is judged on its title, which is what the
 * agent shows as the command.
 */
export function decidePermission(policy: AgentPolicy, req: PermissionRequest): PermissionDecision {
  const call = req.toolCall;
  const refuse = (reason: string): PermissionDecision => ({
    allow: false,
    optionId: pick(req.options, ['reject_once', 'reject_always']) ?? PERMISSION_CANCELLED,
    reason,
  });
  const violation = policyViolation(policy, { ...call, command: call.command ?? call.title });
  if (violation !== undefined) {
    return refuse(violation);
  }
  const optionId = pick(req.options, ['allow_once']);
  if (optionId === undefined) {
    return refuse('the agent offered no allow_once option');
  }
  return { allow: true, optionId };
}
