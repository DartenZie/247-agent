import { lintJmespath, parseJmespath, unplace } from '../expr/jmespath.js';
import { forEachTemplate, parseTemplate } from '../expr/template.js';
import { formatPath, type ConfigIssue } from './load.js';
import type { TaskConfig } from './schema.js';
import { taskActions } from './walk.js';

/** One lint finding: the task it is in, the issue path, what is wrong. */
export interface TaskWarning {
  task: string;
  path: string;
  message: string;
}

/**
 * Warnings, not errors: expressions that are valid but almost certainly wrong
 * (`lintJmespath`). Linted are every bare JMESPath a task holds (the trigger `filter`, each
 * `emit` rule's `when`, each sequence step's `when`, each `agent` post gate's `when`), the
 * expression inside every `${…}` template of its `action`, `emit` rules and
 * `state_updates` (the strings the schema checks as templates), and each `wait`'s
 * `for.filter` as a whole, with every template in it standing in as a placeholder
 * (`lintWaitFilter`).
 */
export function lintTasks(tasks: readonly TaskConfig[]): TaskWarning[] {
  const out: TaskWarning[] = [];
  tasks.forEach((task, i) => {
    const at = `tasks[${String(i)}]`;
    const add = (path: string, messages: readonly string[]): void => {
      for (const message of messages) {
        out.push({ task: task.name, path, message });
      }
    };
    const bare = (expr: string | undefined, path: string): void => {
      if (expr !== undefined) {
        add(path, lintJmespath(expr));
      }
    };
    /** Each `${…}` expression of every template inside `value`. */
    const templates = (value: unknown, base: string): void => {
      forEachTemplate(value, (text, sub) => {
        add(
          `${base}.${formatPath(sub)}`,
          templateExprs(text).flatMap((e) => lintJmespath(e)),
        );
      });
    };

    if (task.trigger.kind === 'event') {
      bare(task.trigger.filter, `${at}.trigger.filter`);
    }
    for (const { action, at: actionAt } of taskActions(task, `${at}.action`)) {
      if ('when' in action) {
        bare(action.when, `${actionAt}.when`);
      }
      if (action.kind === 'wait' && action.for.filter !== undefined) {
        add(`${actionAt}.for.filter`, lintWaitFilter(action.for.filter));
      } else if (action.kind === 'agent') {
        action.post.forEach((gate, g) => {
          bare(gate.when, `${actionAt}.post[${String(g)}].when`);
        });
      }
    }
    templates(task.action, `${at}.action`);
    task.emit?.forEach((rule, j) => {
      const ruleAt = `${at}.emit[${String(j)}]`;
      bare(rule.when, `${ruleAt}.when`);
      templates({ each: rule.each, dedup_key: rule.dedup_key, payload: rule.payload }, ruleAt);
    });
    if (task.state_updates !== undefined) {
      templates(task.state_updates, `${at}.state_updates`);
    }
  });
  return out;
}

/** `lintTasks` as issues for `oa validate`, each message naming its task. */
export function lintIssues(tasks: readonly TaskConfig[]): ConfigIssue[] {
  return lintTasks(tasks).map((w) => ({ path: w.path, message: `task "${w.task}": ${w.message}` }));
}

/** The expressions of a template; none when it does not parse (the schema reports that). */
function templateExprs(text: string): string[] {
  try {
    return parseTemplate(text).flatMap((p) => ('expr' in p ? [p.expr] : []));
  } catch {
    return [];
  }
}

/**
 * A `wait` filter is rendered as text (`ctx.renderText`) and parsed only when the run
 * suspends, so its `${…}` values land in the JMESPath unquoted: a string as is, anything
 * else as JSON. The filter as written is linted with each template replaced by an
 * identifier, which parses wherever a value may stand; an identifier left as a comparison
 * operand is a template interpolated unquoted. A filter that does not parse even so is
 * reported too: at run time the dispatcher cannot compile it and the wait never matches.
 */
function lintWaitFilter(filter: string): string[] {
  let parts;
  try {
    parts = parseTemplate(filter);
  } catch {
    return []; // the schema reports a broken template
  }
  const placeholders = new Map<string, string>();
  const text = parts
    .map((p) => {
      if ('text' in p) {
        return p.text;
      }
      const placeholder = `__oa_tpl_${String(placeholders.size)}__`;
      placeholders.set(placeholder, `\${${p.expr}}`);
      return placeholder;
    })
    .join('');
  const p = parseJmespath(text);
  if (!p.ok) {
    const error = unplace(p.message, placeholders);
    return [
      placeholders.size === 0
        ? `${filter}: not valid JMESPath, so the wait never matches an event: ${error}`
        : `${filter}: not valid JMESPath even with each \${…} standing for a value; the wait matches only if what it renders to parses: ${error}`,
    ];
  }
  return lintJmespath(text, { placeholders });
}
