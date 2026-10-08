// `@types/jmespath` only declares `search`; the runtime also exports `compile`, which we use
// to validate filter syntax at config load time, and `tokenize`, which the lint reads to
// quote an expression as it was written.
export {};

declare module 'jmespath' {
  /** Parses `expression` and returns its AST. Throws `ParserError`/`LexerError` on bad syntax. */
  export function compile(expression: string): unknown;
  /** The lexer's tokens, each with its offset in `expression`. Throws `LexerError`. */
  export function tokenize(expression: string): { type: string; value: unknown; start: number }[];
}
