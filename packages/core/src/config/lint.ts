import { lintJmespath } from '../expr/jmespath.js';
import type { ConfigIssue } from './load.js';
import type { TaskConfig } from './schema.js';

/**
 * Warnings, not errors: expressions that are valid but almost certainly wrong. Every
 * JMESPath a task holds is linted with `lintJmespath`: the trigger `filter`, each `emit`
 * rule's `when`, a `wait` action's `for.filter` (as written, before templating), each
 * sequence step's `when` and `for.filter`, and each `agent` post gate's `when`. A message
 * names the task, so it reads on its own outside the file.
 */
export function lintTasks(tasks: readonly TaskConfig[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  tasks.forEach((task, i) => {
    const at = `tasks[${String(i)}]`;
    const lint = (expr: string | undefined, path: string): void => {
      if (expr === undefined) {
        return;
      }
      for (const message of lintJmespath(expr)) {
        issues.push({ path, message: `task "${task.name}": ${message}` });
      }
    };
    if (task.trigger.kind === 'event') {
      lint(task.trigger.filter, `${at}.trigger.filter`);
    }
    task.emit?.forEach((rule, j) => {
      lint(rule.when, `${at}.emit[${String(j)}].when`);
    });
    const a = task.action;
    if (a.kind === 'wait') {
      lint(a.for.filter, `${at}.action.for.filter`);
    } else if (a.kind === 'sequence') {
      a.steps.forEach((step, k) => {
        const stepAt = `${at}.action.steps[${String(k)}]`;
        lint(step.when, `${stepAt}.when`);
        if (step.kind === 'wait') {
          lint(step.for.filter, `${stepAt}.for.filter`);
        }
      });
    } else if (a.kind === 'agent') {
      a.post.forEach((gate, g) => {
        lint(gate.when, `${at}.action.post[${String(g)}].when`);
      });
    }
  });
  return issues;
}
