/**
 * Sender authentication from the `Authentication-Results` headers (RFC 8601) that the
 * receiving server adds. Anyone can write such a header into a mail, so only headers
 * whose authserv-id is one the operator configured count, and of those only the topmost:
 * the receiving server prepends its own above anything the sender put there.
 */
import type { JsonValue } from '@247-agent/connector-sdk';

/** What a task filter reads as `payload.auth`. Results are lower-case RFC 8601 words. */
export interface SenderAuth {
  /** The trusted authserv-id the results come from; null when no trusted header was found. */
  authserv_id: string | null;
  /** `pass` when any DKIM signature passed, else the first DKIM result, else `none`. */
  dkim: string;
  /** The domains (`header.d`, else `header.i`) of the passing DKIM signatures. */
  dkim_domains: string[];
  spf: string;
  /** `none` unless the header holds exactly one DMARC result and it names the domain of `from`. */
  dmarc: string;
  [key: string]: JsonValue;
}

interface MethodResult {
  method: string;
  result: string;
  props: Map<string, string>;
}

const NO_AUTH: SenderAuth = {
  authserv_id: null,
  dkim: 'none',
  dkim_domains: [],
  spf: 'none',
  dmarc: 'none',
};

/**
 * `headers` are the raw `Authentication-Results` values, topmost first. `from` is the
 * bare sender address the DMARC result must belong to.
 */
export function senderAuth(headers: string[], trusted: string[], from: string): SenderAuth {
  const ids = new Set(trusted.map((t) => t.toLowerCase()));
  for (const value of headers) {
    const parsed = parseAuthResults(value);
    if (parsed === null || !ids.has(parsed.authservId)) {
      continue;
    }
    const of = (method: string): MethodResult[] =>
      parsed.results.filter((r) => r.method === method);
    const dkim = of('dkim');
    const passed = dkim.filter((r) => r.result === 'pass');
    // A message has one SPF and one DMARC verdict. Two in one header mean text the server
    // copied from the sender (an unescaped `)` in a comment) forged one, so neither counts.
    const single = (method: string): MethodResult | undefined => {
      const found = of(method);
      return found.length === 1 ? found[0] : undefined;
    };
    const dmarc = single('dmarc');
    const fromDomain = from.slice(from.lastIndexOf('@') + 1);
    return {
      authserv_id: parsed.authservId,
      dkim: passed.length > 0 ? 'pass' : (dkim[0]?.result ?? 'none'),
      dkim_domains: passed.flatMap((r) => {
        const d = r.props.get('header.d') ?? r.props.get('header.i')?.replace(/^.*@/, '');
        return d === undefined || d === '' ? [] : [d.toLowerCase()];
      }),
      spf: single('spf')?.result ?? 'none',
      dmarc:
        dmarc !== undefined &&
        from !== '' &&
        dmarc.props.get('header.from')?.toLowerCase() === fromDomain
          ? dmarc.result
          : 'none',
    };
  }
  return { ...NO_AUTH, dkim_domains: [] };
}

/** `authserv-id [version]; method=result ptype.prop=value …; …`, or null when malformed. */
export function parseAuthResults(
  value: string,
): { authservId: string; results: MethodResult[] } | null {
  const [head, ...rest] = splitStatements(stripComments(value.replace(/\r?\n[ \t]+/g, ' ')));
  const authservId = unquote(head?.trim().split(/\s+/)[0] ?? '').toLowerCase();
  // Microsoft writes `spf=pass …` where the authserv-id belongs; such a header names no server.
  if (authservId === '' || authservId.includes('=')) {
    return null;
  }
  const results: MethodResult[] = [];
  for (const statement of rest) {
    const [first, ...pairs] = statement.trim().split(/\s+/);
    const m = /^([a-z0-9_-]+)(?:\/\d+)?=([a-z0-9_-]+)$/i.exec(first ?? '');
    const [, method, result] = m ?? [];
    if (method === undefined || result === undefined) {
      continue; // `none`, or something this parser does not know
    }
    const props = new Map<string, string>();
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq > 0) {
        props.set(pair.slice(0, eq).toLowerCase(), unquote(pair.slice(eq + 1)));
      }
    }
    results.push({ method: method.toLowerCase(), result: result.toLowerCase(), props });
  }
  return { authservId, results };
}

/** Drops `(comments)`, which may nest, outside quoted strings. */
function stripComments(s: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '\\' && (quoted || depth > 0)) {
      if (depth === 0) {
        out += c + (s[i + 1] ?? '');
      }
      i++;
    } else if (quoted) {
      quoted = c !== '"';
      out += c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && depth > 0) {
      depth--;
    } else if (depth === 0) {
      quoted = c === '"';
      out += c;
    }
  }
  return out;
}

/** Splits on `;` outside quoted strings. */
function splitStatements(s: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '\\' && quoted) {
      current += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
    }
    if (c === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
    ? s.slice(1, -1).replace(/\\(.)/g, '$1')
    : s;
}
