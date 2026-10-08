import { evaluateExpr, parseTemplate, stringifyValue, type TemplateScope } from './template.js';

/**
 * Rendering of a `wait`'s `for.filter` (docs/internal/actions.md): a JMESPath with `${…}`
 * templates in it, rendered against the waiting run's scope and only then parsed. Each
 * value lands in the expression as data, never as syntax, so a value from the trigger
 * event cannot break the filter or widen it (GHSA-6xm2-r635-x33f). Where the template
 * sits decides how:
 *
 * - inside `'…'`: the string the literal spells, text around the template included. It is
 *   kept as written when the value needs no escaping, else the literal becomes a JSON
 *   string in backticks, since jmespath.js unescapes only the first `\'` of a raw string;
 * - inside `` `…` ``: the value's JSON when the template is the whole literal, else the
 *   value as text, JSON-escaped, inside the literal as written;
 * - inside `"…"`: the value as text, JSON-escaped, in the quoted identifier;
 * - bare: the value's JSON in backticks, so a string compares as a string.
 *
 * Backticks inside a JSON literal are written as `\u0060`: the lexer unescapes only the
 * first `` \` ``. A missing value is the empty string inside quotes and `null` elsewhere.
 */
export function renderFilter(text: string, scope: TemplateScope): string {
  const out: string[] = [];
  let lit: Literal | undefined;
  for (const part of parseTemplate(text)) {
    if ('expr' in part) {
      const value = evaluateExpr(part.expr, scope);
      if (lit === undefined) {
        out.push(`\`${jsonLiteral(value)}\``);
      } else {
        lit.chunks.push({ value });
      }
      continue;
    }
    const s = part.text;
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (lit === undefined) {
        if (c === "'" || c === '"' || c === '`') {
          lit = { quote: c, chunks: [] };
        } else {
          out.push(c);
        }
        continue;
      }
      if (c === '\\' && i + 1 < s.length) {
        lit.chunks.push({ text: s.slice(i, i + 2) });
        i++;
      } else if (c === lit.quote) {
        out.push(closeLiteral(lit));
        lit = undefined;
      } else {
        lit.chunks.push({ text: c });
      }
    }
  }
  if (lit !== undefined) {
    // Unterminated: the filter is invalid as written; leave it so the dispatcher says so.
    out.push(
      lit.quote,
      ...lit.chunks.map((ch) => ('text' in ch ? ch.text : stringifyValue(ch.value))),
    );
  }
  return out.join('');
}

type Chunk = { text: string } | { value: unknown };

interface Literal {
  quote: "'" | '"' | '`';
  /** Written text, escapes as written, and the values rendered into it. */
  chunks: Chunk[];
}

/** The literal with its values in, in the form the lexer reads back as meant. */
function closeLiteral(lit: Literal): string {
  const values = lit.chunks.filter((ch): ch is { value: unknown } => 'value' in ch);
  const written = lit.chunks.map((ch) => ('text' in ch ? ch.text : '')).join('');
  if (values.length === 0) {
    return `${lit.quote}${written}${lit.quote}`;
  }
  switch (lit.quote) {
    case "'": {
      const content = lit.chunks
        .map((ch) => ('text' in ch ? unescapeRaw(ch.text) : stringifyValue(ch.value)))
        .join('');
      return /['\\]/.test(content) ? `\`${jsonLiteral(content)}\`` : `'${content}'`;
    }
    case '"':
      return `"${lit.chunks.map((ch) => ('text' in ch ? ch.text : jsonText(ch.value))).join('')}"`;
    case '`': {
      const [only] = values;
      if (values.length === 1 && written === '' && only !== undefined) {
        return `\`${jsonLiteral(only.value)}\``;
      }
      return `\`${lit.chunks.map((ch) => ('text' in ch ? ch.text : jsonText(ch.value))).join('')}\``;
    }
  }
}

/** A raw-string escape as the JMESPath spec reads it: `\'` and `\\`; anything else as is. */
function unescapeRaw(written: string): string {
  return written === "\\'" || written === '\\\\' ? written.charAt(1) : written;
}

/** The value's JSON, safe inside a backtick literal. */
function jsonLiteral(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value).replaceAll('`', '\\u0060');
}

/** The value as text, escaped for the inside of a JSON string (no surrounding quotes). */
function jsonText(value: unknown): string {
  return JSON.stringify(stringifyValue(value)).slice(1, -1).replaceAll('`', '\\u0060');
}
