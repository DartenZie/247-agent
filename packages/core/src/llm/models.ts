/**
 * Which Claude models take `output_config.effort` and adaptive thinking (CLAUDE.md):
 * Sonnet/Opus 5 do, Haiku 4.5 has neither. Adapters drop both on other models rather
 * than fail the call.
 */
export function supportsEffort(model: string): boolean {
  return /^claude-(sonnet|opus)-5/.test(model);
}
