/** Secret values shorter than this are not redacted (they would match everywhere). */
export const REDACT_MIN = 4;

/** `[value, replacement]` pairs, longest value first, so a secret inside another goes second. */
export function redactions(secrets: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(secrets)
    .filter(([, value]) => value.length >= REDACT_MIN)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, value]) => [value, `[secret:${name}]`]);
}

/** Replaces every secret value in `text` with `[secret:<name>]`. */
export function redact(text: string, pairs: readonly (readonly [string, string])[]): string {
  let out = text;
  for (const [value, replacement] of pairs) {
    out = out.split(value).join(replacement);
  }
  return out;
}
