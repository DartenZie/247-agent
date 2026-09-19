import { compile, search } from 'jmespath';

/**
 * `${ <JMESPath> }` templating (ARCHITECTURE §5). Expressions are evaluated against a
 * scope of `{event, result, state, secrets, env, item, run, steps}`; which keys are present
 * depends on where the template appears. A string that is exactly one `${…}` renders to the
 * expression's raw value (so `stdin: ${event.payload}` stays JSON); a string with text
 * around or between templates renders to a string, non-string values JSON-encoded and
 * `null` as the empty string.
 */

export interface TemplateScope {
  event?: unknown;
  result?: unknown;
  state?: unknown;
  secrets?: unknown;
  env?: unknown;
  item?: unknown;
  run?: unknown;
  steps?: unknown;
}

export type TemplatePart = { text: string } | { expr: string };

export interface Template {
  readonly source: string;
  readonly parts: readonly TemplatePart[];
  /** True when the whole string is one `${…}`. */
  readonly whole: boolean;
  /** Root names referenced by the expressions (`event`, `secrets`, …). */
  readonly roots: ReadonlySet<string>;
  /** Names referenced as `secrets.<name>`. */
  readonly secrets: readonly string[];
  /** True when an expression uses `secrets` other than as `secrets.<name>`. */
  readonly wholeSecrets: boolean;
  render(scope: TemplateScope): unknown;
  renderText(scope: TemplateScope): string;
}

export class TemplateSyntaxError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(message);
    this.name = 'TemplateSyntaxError';
  }
}

/** Thrown at render time when an expression fails (a JMESPath runtime type error). */
export class TemplateRenderError extends Error {
  constructor(
    readonly expr: string,
    cause: unknown,
  ) {
    super(`cannot render \${${expr}}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TemplateRenderError';
  }
}

interface AstNode {
  type: string;
  name?: string;
  value?: unknown;
  children?: (AstNode | null)[];
}

interface Refs {
  roots: Set<string>;
  secrets: string[];
  wholeSecrets: boolean;
}

/**
 * Collects the root identifiers of an expression: identifiers that resolve against the
 * scope itself, not against an intermediate value (`a` in `a.b`, `x` and `y` in
 * `x == y`, `z` in `length(z)`). Also records `secrets.<name>` references.
 */
function collectRefs(node: AstNode | null | undefined, refs: Refs): void {
  if (node === null || node === undefined) {
    return;
  }
  const kids = node.children ?? [];
  switch (node.type) {
    case 'Field':
      if (node.name !== undefined) {
        refs.roots.add(node.name);
        if (node.name === 'secrets') {
          refs.wholeSecrets = true;
        }
      }
      return;
    case 'Subexpression': {
      const [left, right] = kids;
      if (left?.type === 'Field' && left.name === 'secrets') {
        refs.roots.add('secrets');
        if (right?.type === 'Field' && right.name !== undefined) {
          refs.secrets.push(right.name);
        } else {
          refs.wholeSecrets = true;
        }
        return;
      }
      collectRefs(left, refs);
      return;
    }
    case 'IndexExpression':
    case 'Projection':
    case 'ValueProjection':
    case 'FilterProjection':
    case 'Pipe':
    case 'Flatten':
      collectRefs(kids[0], refs);
      return;
    case 'KeyValuePair':
      collectRefs(node.value as AstNode, refs);
      return;
    case 'ExpressionReference':
    case 'NotExpression':
    case 'OrExpression':
    case 'AndExpression':
    case 'Comparator':
    case 'Function':
    case 'MultiSelectList':
    case 'MultiSelectHash':
      for (const child of kids) {
        collectRefs(child, refs);
      }
      return;
    default:
      // Literal, Identity, Current, Index, Slice: no references.
      return;
  }
}

/**
 * Finds the `}` that closes a `${` opened at `open`, skipping braces inside JMESPath
 * string literals (`'…'`, `"…"`) and backtick JSON literals. Returns -1 if unterminated.
 */
function findClose(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote !== null) {
      if (c === '\\') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

export function parseTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  let literal = '';
  while (i < text.length) {
    const open = text.indexOf('${', i);
    if (open < 0) {
      literal += text.slice(i);
      break;
    }
    const close = findClose(text, open + 1);
    if (close < 0) {
      throw new TemplateSyntaxError(text, `unterminated \${ at offset ${String(open)}`);
    }
    literal += text.slice(i, open);
    const expr = text.slice(open + 2, close).trim();
    if (expr === '') {
      throw new TemplateSyntaxError(text, `empty \${} at offset ${String(open)}`);
    }
    if (literal !== '') {
      parts.push({ text: literal });
      literal = '';
    }
    parts.push({ expr });
    i = close + 1;
  }
  if (literal !== '' || parts.length === 0) {
    parts.push({ text: literal });
  }
  return parts;
}

export function isTemplate(value: unknown): value is string {
  return typeof value === 'string' && value.includes('${');
}

/** JSON encoding for a template value that lands inside a larger string. */
export function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'string') {
    return v;
  }
  return JSON.stringify(v);
}

function evaluate(expr: string, scope: TemplateScope): unknown {
  try {
    return search(scope, expr);
  } catch (err) {
    throw new TemplateRenderError(expr, err);
  }
}

/** Compiles a string into a template; throws `TemplateSyntaxError` on bad `${…}` or JMESPath. */
export function compileTemplate(text: string): Template {
  const parts = parseTemplate(text);
  const refs: Refs = { roots: new Set(), secrets: [], wholeSecrets: false };
  for (const part of parts) {
    if (!('expr' in part)) {
      continue;
    }
    let ast: unknown;
    try {
      ast = compile(part.expr);
    } catch (err) {
      throw new TemplateSyntaxError(
        text,
        `invalid JMESPath "${part.expr}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    collectRefs(ast as AstNode, refs);
  }
  const first = parts[0];
  const wholeExpr =
    parts.length === 1 && first !== undefined && 'expr' in first ? first.expr : undefined;
  const whole = wholeExpr !== undefined;
  const renderText = (scope: TemplateScope): string =>
    parts.map((p) => ('text' in p ? p.text : stringifyValue(evaluate(p.expr, scope)))).join('');
  return {
    source: text,
    parts,
    whole,
    roots: refs.roots,
    secrets: refs.secrets,
    wholeSecrets: refs.wholeSecrets,
    render: (scope) => (wholeExpr === undefined ? renderText(scope) : evaluate(wholeExpr, scope)),
    renderText,
  };
}

const cache = new Map<string, Template>();

function cached(text: string): Template {
  let t = cache.get(text);
  if (t === undefined) {
    t = compileTemplate(text);
    if (cache.size > 10_000) {
      cache.clear();
    }
    cache.set(text, t);
  }
  return t;
}

/** Returns an error message, or null when `text` is a valid template. */
export function validateTemplate(text: string): string | null {
  try {
    cached(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Renders one string: whole-template → raw value, otherwise a string. */
export function renderTemplate(text: string, scope: TemplateScope): unknown {
  return isTemplate(text) ? cached(text).render(scope) : text;
}

/** Renders one string to a string, JSON-encoding a non-string whole-template value. */
export function renderText(text: string, scope: TemplateScope): string {
  return isTemplate(text) ? cached(text).renderText(scope) : text;
}

/**
 * Renders every string inside a JSON-like value, recursively. Object keys are never
 * templated. Whole-template strings are replaced by their raw value.
 */
export function renderValue(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') {
    return renderTemplate(value, scope);
  }
  if (Array.isArray(value)) {
    return value.map((v: unknown) => renderValue(v, scope));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderValue(v, scope);
    }
    return out;
  }
  return value;
}

export interface TemplateRefs {
  /** Root scope names used anywhere in the value. */
  roots: Set<string>;
  /** Secret names used as `secrets.<name>`, deduplicated, in first-use order. */
  secrets: string[];
  /** Templates that use `secrets` other than as `secrets.<name>`. */
  wholeSecrets: string[];
  /** Template strings that failed to compile, with the error. */
  errors: { template: string; message: string }[];
}

/** Walks a JSON-like value and reports what its templates reference. */
export function collectTemplateRefs(value: unknown, refs?: TemplateRefs): TemplateRefs {
  const out: TemplateRefs = refs ?? { roots: new Set(), secrets: [], wholeSecrets: [], errors: [] };
  if (typeof value === 'string') {
    if (!isTemplate(value)) {
      return out;
    }
    let t: Template;
    try {
      t = cached(value);
    } catch (err) {
      out.errors.push({
        template: value,
        message: err instanceof Error ? err.message : String(err),
      });
      return out;
    }
    for (const r of t.roots) {
      out.roots.add(r);
    }
    for (const s of t.secrets) {
      if (!out.secrets.includes(s)) {
        out.secrets.push(s);
      }
    }
    if (t.wholeSecrets) {
      out.wholeSecrets.push(value);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) {
      collectTemplateRefs(v, out);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectTemplateRefs(v, out);
    }
  }
  return out;
}

/**
 * Evaluates a bare JMESPath (not a `${…}` template) against the scope, as `when:` and
 * `each:` do. Throws `TemplateRenderError` on a runtime error.
 */
export function evaluateExpr(expr: string, scope: TemplateScope): unknown {
  return evaluate(expr, scope);
}
