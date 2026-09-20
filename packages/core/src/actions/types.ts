import type { TaskConfig } from '../config/schema.js';
import { renderText, renderValue, type TemplateScope } from '../expr/template.js';
import type { LlmPort } from '../llm/types.js';
import type { Logger } from '../log.js';
import type { StateSnapshot } from '../store/state.js';
import type { EventRecord, JsonValue, RunRecord } from '../store/types.js';
import type { SandboxConfig } from './sandbox.js';

/** An operation on a connector, as the `connector` action and sequences call it. */
export interface ConnectorClients {
  /** Names of the configured connectors. */
  names(): string[];
  call(
    connector: string,
    op: string,
    args: Record<string, JsonValue>,
    opts: { signal: AbortSignal; timeoutMs?: number | undefined },
  ): Promise<JsonValue>;
}

/** What a `wait` suspends the run for (ARCHITECTURE §5.5). */
export interface WaitSpec {
  /** Event type pattern (`*` = one segment). */
  type: string;
  /** JMESPath over the incoming event, already rendered. */
  filter?: string | undefined;
  timeoutMs?: number | undefined;
  on_timeout: 'fail' | 'succeed';
}

/** Present on the context of a run that resumes after a wait. */
export interface ResumeInfo {
  /** What the suspending runner stored (a sequence's step index and earlier results). */
  readonly resume: JsonValue;
  readonly outcome: 'matched' | 'timeout';
  /** The matching event when `outcome` is `matched`. */
  readonly event?: EventRecord | undefined;
}

/**
 * What every action runner receives. `event` is the triggering event as the action should
 * see it: for a `manual.run` trigger with `payload.event`, that inner event (with the
 * `manual.run` event's ids and correlation), otherwise the trigger event itself.
 */
export interface ActionContext {
  readonly run: RunRecord;
  readonly event: EventRecord;
  readonly task: TaskConfig;
  /** Aborted on task timeout or daemon shutdown; runners must stop what they started. */
  readonly signal: AbortSignal;
  /** Already carries `run_id`, `task` and `correlation_id`. */
  readonly log: Logger;
  /** The KV store as of the run's start. */
  readonly state: StateSnapshot;
  /** The secrets this task's templates name, resolved for this run. Never log them. */
  readonly secrets: Readonly<Record<string, string>>;
  /** `{event, state, secrets, env, run}`, plus `steps` inside a sequence. */
  readonly scope: TemplateScope;
  /** Renders every `${…}` in a value against `scope` (`renderValue`). */
  render(value: unknown): unknown;
  /** Renders one string to a string. */
  renderText(text: string): string;
  /** Connector ops; absent when the core runs without a connector supervisor. */
  readonly connectors?: ConnectorClients | undefined;
  /** `defaults.sandbox` from agent.yaml, for `shell` actions without their own. */
  readonly sandbox?: SandboxConfig | undefined;
  /** Model calls for `llm` actions; absent when the core runs without `providers`. */
  readonly llm?: LlmPort | undefined;
  /**
   * Parks the run in `waiting` until an event matches `spec` or it times out; the executor
   * then starts the runner again with `resume` set. The returned promise never resolves:
   * it rejects with the executor's suspension signal, which the runner lets propagate.
   */
  suspend(spec: WaitSpec, resume: JsonValue): Promise<never>;
  /** Set when the run continues after a wait. */
  readonly resume?: ResumeInfo | undefined;
}

/**
 * One runner per action kind, in its own file. The runner narrows `action` with its own
 * zod schema, does the work and returns the JSON result the core stores and routes.
 * A thrown error (or rejection) fails the run with the error's message.
 */
export type ActionRunner = (action: unknown, ctx: ActionContext) => Promise<JsonValue>;

export type ActionKind = TaskConfig['action']['kind'];

export type ActionRunners = Partial<Record<ActionKind, ActionRunner>>;

/** A copy of `ctx` whose scope gains `extra` (a sequence adds `steps`); rendering follows. */
export function withScope(ctx: ActionContext, extra: TemplateScope): ActionContext {
  const scope: TemplateScope = { ...ctx.scope, ...extra };
  return {
    ...ctx,
    scope,
    render: (value) => renderValue(value, scope),
    renderText: (text) => renderText(text, scope),
  };
}

/** Marks an error the executor must not retry (a wait timeout, a config problem). */
export class NonRetryableError extends Error {
  readonly retryable = false as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

export function isRetryable(err: unknown): boolean {
  return !(err instanceof Error && 'retryable' in err && err.retryable === false);
}
