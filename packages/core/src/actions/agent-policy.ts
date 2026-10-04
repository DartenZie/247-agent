import { isInside } from '../config/crosscheck.js';
import {
  PERMISSION_CANCELLED,
  type PermissionOptionKind,
  type PermissionRequest,
  type ToolKind,
} from '../connectors/acp-types.js';

/**
 * What an `agent` action lets its ACP agent do (docs/internal/agent-action.md, docs/internal/security.md): the tool kinds
 * in `tools`, shell commands that start with a `bash_allow` entry, and paths inside the
 * workspace. Everything else is refused when the agent asks.
 */
export interface AgentPolicy {
  tools: readonly ToolKind[];
  bashAllow: readonly string[];
  workspace: string;
  /**
   * What to make of an `execute` call the agent ran without asking. `judge` (default):
   * its command must pass `bashAllow` like one that asked. `sandboxed`: the agent's own
   * sandbox already confined it (no writes outside the workspace, no network: what Codex
   * enforces at the OS level for commands it does not ask about), so only its kind and
   * paths are judged. Calls that ask are always judged in full.
   */
  unaskedExecute: 'judge' | 'sandboxed';
}

/** `optionId` is what to answer: an offered option, or `PERMISSION_CANCELLED`. */
export type PermissionDecision =
  { allow: true; optionId: string } | { allow: false; optionId: string; reason: string };

/**
 * Shell syntax that would run something other than the visible programs: redirections,
 * substitutions, line breaks. Never allowed except in an exact entry, quoted or not: the
 * core does not parse shell.
 */
const SHELL_UNSAFE = /[<>`\n\r]|\$\(|\$\{/;

/**
 * Splits a command on the operators that chain whole commands (`&&`, `||`, `|`, `;`, `&`)
 * the way a POSIX shell reads them: an operator inside single or double quotes, or
 * escaped with a backslash, is an argument of the program before it, not a chain. That is
 * what lets `grep -E "a|b" data` pass under `["grep"]` while `grep a | sh` still needs
 * `sh` listed. Returns `null` for an unterminated quote, which no shell would run either.
 */
export function splitChain(command: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command.charAt(i + 1);
        i += 1;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command.charAt(i + 1);
      i += 2;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (quote !== null) {
    return null;
  }
  segments.push(current);
  return segments.map((s) => s.trim());
}

function segmentAllowed(segment: string, allow: readonly string[]): boolean {
  return (
    allow.includes(segment) ||
    allow.some((p) => segment.startsWith(p + ' ') || segment.startsWith(p + '\t'))
  );
}

/**
 * True when `command` is an `allow` entry itself, or a linear chain (`a && b | c; d`) in
 * which every segment is an entry or starts with one followed by whitespace, with no
 * redirection, substitution or line break anywhere, quoted or not. Only an exact entry
 * can carry those, so `bash_allow: ["npm run build"]` admits `git status && npm run build`
 * only when `git status` is listed too, and never `npm run build > ~/.profile` or
 * `… $(curl …)`. A chain operator inside quotes belongs to the segment's own arguments
 * (`splitChain`), so what runs is still only the listed programs.
 */
export function commandAllowed(command: string, allow: readonly string[]): boolean {
  const c = command.trim();
  if (allow.includes(c)) {
    return true;
  }
  if (SHELL_UNSAFE.test(c)) {
    return false;
  }
  const segments = splitChain(c);
  return segments?.every((s) => s !== '' && segmentAllowed(s, allow)) ?? false;
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
 * without a known command cannot be judged on its command (only on its kind and paths);
 * neither is one the agent ran without asking (`asked: false`) under
 * `unaskedExecute: sandboxed`.
 */
export function policyViolation(
  policy: AgentPolicy,
  call: JudgedCall,
  { asked }: { asked: boolean } = { asked: true },
): string | undefined {
  if (!policy.tools.includes(call.toolKind)) {
    return `tool kind "${call.toolKind}" is not in tools`;
  }
  const judgeCommand = asked || policy.unaskedExecute === 'judge';
  if (
    call.toolKind === 'execute' &&
    judgeCommand &&
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
