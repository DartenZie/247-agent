import type { AgentStop, AgentUpdate, PermissionRequest } from '../connectors/acp-types.js';
import type { Logger } from '../log.js';
import type { NewTranscriptEntry, TranscriptSink } from '../store/transcripts.js';
import type { JsonValue } from '../store/types.js';
import type { PermissionDecision } from './agent-policy.js';
import type { AgentResult } from './agent-result.js';

/** Characters of text kept in one row; a longer message continues in the next row. */
export const TRANSCRIPT_TEXT_MAX = 64_000;
/** Secret values shorter than this are not redacted (they would match everywhere). */
const REDACT_MIN = 4;

export interface TranscriptWriterOptions {
  /** Absent when the core runs without a store (runner tests): nothing is written. */
  sink: TranscriptSink | undefined;
  runId: string;
  /** The run's resolved secrets; their values never reach a row. */
  secrets: Readonly<Record<string, string>>;
  log: Logger;
  clock?: (() => Date) | undefined;
}

/**
 * Persists an `agent` run's session as transcript rows (docs/internal/agent-action.md): the prompt,
 * the agent's messages and thoughts (chunks coalesced per kind), each tool call and
 * update, every permission decision, usage, the stop, a cancel and the result. Best
 * effort: a failing sink is logged once and the run goes on. Secret values are replaced
 * by `[secret:<name>]` before anything is stored.
 */
export class TranscriptWriter {
  private turn = 0;
  private buffered: { kind: 'text' | 'thought'; text: string } | undefined;
  private failed = false;
  private readonly redactions: [string, string][];
  private readonly clock: () => Date;

  constructor(private readonly opts: TranscriptWriterOptions) {
    this.redactions = Object.entries(opts.secrets)
      .filter(([, value]) => value.length >= REDACT_MIN)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, value]) => [value, `[secret:${name}]`]);
    this.clock = opts.clock ?? (() => new Date());
  }

  /** A new prompt turn (1 for the task prompt, 2 for the nudge). */
  begin(prompt: string): void {
    this.flush();
    this.turn++;
    this.write('prompt', prompt, null);
  }

  update(u: AgentUpdate): void {
    switch (u.kind) {
      case 'text':
      case 'thought':
        this.chunk(u.kind, u.text);
        return;
      case 'tool_call':
        this.write('tool_call', null, {
          id: u.id,
          title: u.title,
          tool_kind: u.toolKind,
          status: u.status,
          command: u.command ?? null,
          locations: u.locations,
        });
        return;
      case 'tool_call_update':
        this.write('tool_call_update', null, {
          id: u.id,
          status: u.status ?? null,
          ...(u.toolKind === undefined ? {} : { tool_kind: u.toolKind }),
          ...(u.command === undefined ? {} : { command: u.command }),
          ...(u.locations === undefined ? {} : { locations: u.locations }),
        });
        return;
      case 'usage':
        this.write('usage', null, { used: u.used, size: u.size, cost_usd: u.costUsd ?? null });
        return;
      case 'other':
        return;
    }
  }

  permission(req: PermissionRequest, decision: PermissionDecision): void {
    this.write('permission', null, {
      id: req.toolCall.id,
      title: req.toolCall.title,
      tool_kind: req.toolCall.toolKind,
      command: req.toolCall.command ?? null,
      locations: req.toolCall.locations,
      allowed: decision.allow,
      option_id: decision.optionId,
      ...(decision.allow ? {} : { reason: decision.reason }),
    });
  }

  cancel(reason: string, detail: string | undefined): void {
    this.write('cancel', null, { reason, detail: detail ?? null });
  }

  stop(stop: AgentStop): void {
    this.write('stop', null, {
      stop_reason: stop.stopReason,
      input_tokens: stop.usage?.input ?? null,
      output_tokens: stop.usage?.output ?? null,
    });
  }

  result(result: AgentResult): void {
    this.write('result', null, result);
  }

  /** Writes any buffered message text; call before the session closes. */
  flush(): void {
    const b = this.buffered;
    if (b === undefined) {
      return;
    }
    this.buffered = undefined;
    this.write(b.kind, b.text, null);
  }

  private chunk(kind: 'text' | 'thought', text: string): void {
    if (this.buffered !== undefined && this.buffered.kind !== kind) {
      this.flush();
    }
    const b = this.buffered ?? { kind, text: '' };
    this.buffered = b;
    b.text += text;
    while (b.text.length > TRANSCRIPT_TEXT_MAX) {
      const head = b.text.slice(0, TRANSCRIPT_TEXT_MAX);
      b.text = b.text.slice(TRANSCRIPT_TEXT_MAX);
      this.write(kind, head, null);
    }
  }

  private write(
    kind: NewTranscriptEntry['kind'],
    text: string | null,
    data: JsonValue | null,
  ): void {
    if (kind !== 'text' && kind !== 'thought') {
      this.flush();
    }
    const sink = this.opts.sink;
    if (sink === undefined || this.failed) {
      return;
    }
    try {
      sink.append({
        run_id: this.opts.runId,
        ts: this.clock().toISOString(),
        turn: this.turn,
        kind,
        text: text === null ? null : this.redact(text),
        data: data === null ? null : this.redactValue(data),
      });
    } catch (err) {
      this.failed = true;
      this.opts.log.warn('agent.transcript_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private redact(text: string): string {
    let out = text;
    for (const [value, replacement] of this.redactions) {
      out = out.split(value).join(replacement);
    }
    return out;
  }

  private redactValue(value: JsonValue): JsonValue {
    if (typeof value === 'string') {
      return this.redact(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.redactValue(v));
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactValue(v)]));
    }
    return value;
  }
}
