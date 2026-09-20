/**
 * Which Claude models take `output_config.effort` and adaptive thinking (CLAUDE.md):
 * Sonnet/Opus 5 do, Haiku 4.5 has neither. Adapters drop both on other models rather
 * than fail the call.
 */
export function supportsEffort(model: string): boolean {
  return /^claude-(sonnet|opus)-5/.test(model);
}

/**
 * Which OpenAI models take `reasoning.effort`: the gpt-5 and gpt-6 families and the
 * o-series; the chat-tuned `*-chat-*` variants and gpt-4.x do not (developers.openai.com/
 * api/docs/models, 2026-09-20). The adapter drops `effort` on the others rather than fail.
 */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-[5-9]|o\d)/.test(model) && !model.includes('-chat');
}
