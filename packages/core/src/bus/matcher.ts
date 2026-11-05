import type { TaskConfig, TasksFileConfig } from '../config/schema.js';
import { compileTypePattern, isTypePattern, type TypeMatcher } from '../expr/glob.js';
import { compileFilter, type Filter } from '../expr/jmespath.js';
import { collectTemplateRefs } from '../expr/template.js';
import type { Logger } from '../log.js';
import type { EventRecord } from '../store/types.js';

export const CRON_TICK = 'cron.tick';
export const MANUAL_RUN = 'manual.run';
/** Published by the llm service when a call would cross a task budget or the daily cap. */
export const BUDGET_EXCEEDED = 'budget.exceeded';
/** Published by the llm service when a `batch: true` request has ended (docs/internal/model-actions.md). */
export const LLM_BATCH_ENDED = 'llm.batch.ended';
/** Published by the retention pass when it keeps a worktree with commits not pushed yet. */
export const RETENTION_WORKSPACE_KEPT = 'retention.workspace_kept';
/** Published by the dispatcher, once per causal chain, when it first drops one of its events. */
export const LOOP_DETECTED = 'loop.detected';

/** The `type` label of events no task names exactly (see `labelledEventTypes`). */
export const OTHER_EVENT_TYPE = 'other';

/** `source` value of events produced by a task's runs. */
export function taskSource(task: string): string {
  return `task:${task}`;
}

export interface CompiledTask {
  readonly name: string;
  readonly config: TaskConfig;
  readonly kind: 'cron' | 'event' | 'manual';
  /** Cron only: skip a tick while a run for this task is queued, running or waiting. */
  readonly overlapSkip: boolean;
  /** Secrets the action's templates name (`${secrets.<name>}`), resolved per run. */
  readonly secretNames: readonly string[];
  /** Pure except for a warn log when a filter throws at evaluation time. */
  matches(event: EventRecord, log?: Logger): boolean;
  /** Pure: whether the trigger matches the event and, when not, why (`oa events show`). */
  explain(event: EventRecord): MatchVerdict;
}

/**
 * Why a trigger does not match an event: the event came from one of the task's own runs,
 * its type is not one the trigger names, the filter is false, or the filter threw.
 */
export type NoMatchReason = 'own_source' | 'type' | 'filter' | 'filter_error';

export type MatchVerdict =
  | { matched: true }
  | {
      matched: false;
      reason: NoMatchReason;
      /** The source, what the trigger wants, the filter, or the filter's error. */
      detail: string;
    };

const MATCHED: MatchVerdict = { matched: true };

export interface CompiledConfig {
  readonly tasks: readonly CompiledTask[];
  readonly byName: ReadonlyMap<string, CompiledTask>;
}

function payloadTask(event: EventRecord): string | undefined {
  const p = event.payload;
  if (p !== null && typeof p === 'object' && !Array.isArray(p) && typeof p.task === 'string') {
    return p.task;
  }
  return undefined;
}

/** The event as filters see it: everything but the internal `seq`. */
function filterView(event: EventRecord): Omit<EventRecord, 'seq'> {
  const { seq: _seq, ...rest } = event;
  return rest;
}

export function compileTask(task: TaskConfig): CompiledTask {
  const { trigger } = task;
  const own = taskSource(task.name);

  const wantsManual = `wants manual.run for ${task.name}`;
  let wants = trigger.kind === 'cron' ? 'wants its own cron.tick' : wantsManual;
  let typeMatchers: TypeMatcher[] = [];
  let filter: { compiled: Filter; source: string } | undefined;
  if (trigger.kind === 'event') {
    const patterns = trigger.type !== undefined ? [trigger.type] : (trigger.type_any ?? []);
    typeMatchers = patterns.map(compileTypePattern);
    wants = `wants ${patterns.join(' or ')}`;
    filter =
      trigger.filter === undefined
        ? undefined
        : { compiled: compileFilter(trigger.filter), source: trigger.filter };
  }
  const noType: MatchVerdict = { matched: false, reason: 'type', detail: wants };

  const explainEventTrigger = (event: EventRecord): MatchVerdict => {
    if (!typeMatchers.some((m) => m(event.type))) {
      return noType;
    }
    if (filter === undefined) {
      return MATCHED;
    }
    try {
      return filter.compiled.evaluate(filterView(event))
        ? MATCHED
        : { matched: false, reason: 'filter', detail: filter.source };
    } catch (err) {
      return {
        matched: false,
        reason: 'filter_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const explain = (event: EventRecord): MatchVerdict => {
    // A task never triggers on events its own runs produced.
    if (event.source === own) {
      return { matched: false, reason: 'own_source', detail: own };
    }
    // `oa run <task>` works for every task, whatever its trigger kind.
    if (event.type === MANUAL_RUN) {
      return payloadTask(event) === task.name
        ? MATCHED
        : { matched: false, reason: 'type', detail: wantsManual };
    }
    switch (trigger.kind) {
      case 'cron':
        return event.type === CRON_TICK && payloadTask(event) === task.name ? MATCHED : noType;
      case 'event':
        return explainEventTrigger(event);
      case 'manual':
        return noType;
    }
  };

  return {
    name: task.name,
    config: task,
    kind: trigger.kind,
    overlapSkip: trigger.kind === 'cron' && trigger.overlap === 'skip',
    secretNames: collectTemplateRefs(task.action).secrets,
    explain,
    matches: (event, log) => {
      const verdict = explain(event);
      if (!verdict.matched && verdict.reason === 'filter_error') {
        log?.warn('trigger.filter_error', {
          task: task.name,
          event_id: event.id,
          event_type: event.type,
          error: verdict.detail,
        });
      }
      return verdict.matched;
    },
  };
}

export function compileConfig(file: TasksFileConfig): CompiledConfig {
  const tasks = file.tasks.map(compileTask);
  return { tasks, byName: new Map(tasks.map((t) => [t.name, t])) };
}

/**
 * Event types that get their own `type` label on `oa_events_published_total`: the core's
 * own (`cron.tick`, `manual.run`, `budget.exceeded`, `llm.batch.ended`,
 * `retention.workspace_kept`, `loop.detected`, `task.<name>.succeeded|failed|cancelled`) and
 * every type a task names exactly in a trigger, a `wait` or an `emit` rule. Connectors and
 * `POST /v1/events` can publish any type, so everything else (including types only a
 * wildcard matches) is counted as `other` and the label stays bounded by the config.
 */
export function labelledEventTypes(config: CompiledConfig): ReadonlySet<string> {
  const types = new Set<string>([
    CRON_TICK,
    MANUAL_RUN,
    BUDGET_EXCEEDED,
    LLM_BATCH_ENDED,
    RETENTION_WORKSPACE_KEPT,
    LOOP_DETECTED,
  ]);
  const add = (type: string | undefined): void => {
    if (type !== undefined && !isTypePattern(type)) {
      types.add(type);
    }
  };
  for (const { name, config: task } of config.tasks) {
    types.add(`task.${name}.succeeded`);
    types.add(`task.${name}.failed`);
    types.add(`task.${name}.cancelled`);
    if (task.trigger.kind === 'event') {
      add(task.trigger.type);
      task.trigger.type_any?.forEach(add);
    }
    const { action } = task;
    const steps = action.kind === 'sequence' ? action.steps : [action];
    for (const step of steps) {
      if (step.kind === 'wait') {
        add(step.for.type);
      }
    }
    task.emit?.forEach((rule) => {
      add(rule.type);
    });
  }
  return types;
}
