// `@types/jmespath` only declares `search`; the runtime also exports `compile`, which we use
// to validate filter syntax at config load time.
export {};

declare module 'jmespath' {
  /** Parses `expression` and returns its AST. Throws `ParserError`/`LexerError` on bad syntax. */
  export function compile(expression: string): unknown;
}
