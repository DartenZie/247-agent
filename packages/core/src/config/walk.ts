import type { SequenceStepConfig } from '../actions/sequence.js';
import type { TaskConfig } from './schema.js';

/** A task's own action or one of its sequence's steps. */
export type TaskAction = TaskConfig['action'] | SequenceStepConfig;

/**
 * Every action a task runs, with the issue path of each: the task's `action` at `at`, and
 * for a `sequence` also each step at `<at>.steps[<k>]`. The one place that knows which
 * actions nest, so a check that looks at actions of some kind finds them all.
 */
export function taskActions(task: TaskConfig, at: string): { action: TaskAction; at: string }[] {
  const a = task.action;
  const own = { action: a, at };
  if (a.kind !== 'sequence') {
    return [own];
  }
  return [own, ...a.steps.map((s, k) => ({ action: s, at: `${at}.steps[${String(k)}]` }))];
}
