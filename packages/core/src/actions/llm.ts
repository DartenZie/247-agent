import { z } from 'zod';

import { Budget, EFFORTS } from '../llm/config.js';
import type { JsonValue } from '../store/types.js';
import { NonRetryableError, type ActionContext } from './types.js';

const NAME = /^[a-z][a-z0-9_]*$/;

/**
 * ARCHITECTURE §5.2: one model call, optional structured output, no loop. `provider` and
 * `model` fall back to `defaults.llm`. The system prompt is static (it is prompt-cached);
 * everything volatile goes in `input`, which is rendered last.
 */
export const LlmAction = z
  .strictObject({
    kind: z.literal('llm'),
    provider: z.string().regex(NAME, 'provider names are [a-z][a-z0-9_]*').optional(),
    model: z.string().min(1).optional(),
    /** Sonnet/Opus 5 only; adapters drop it on models without an effort parameter. */
    effort: z.enum(EFFORTS).optional(),
    max_tokens: z.number().int().positive().max(128_000).optional(),
    /** Inline system prompt, or `system_file` relative to the agent.yaml directory. */
    system: z.string().min(1).optional(),
    system_file: z.string().min(1).optional(),
    /** Templated; the user turn. */
    input: z.string().min(1),
    /** A JSON Schema object; with it the result is the parsed object, without it `{text}`. */
    output_schema: z.looseObject({ type: z.literal('object') }).optional(),
    budget: Budget.optional(),
  })
  .superRefine((a, ctx) => {
    if (a.system !== undefined && a.system_file !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['system'],
        message: 'use either "system" or "system_file", not both',
      });
    }
    for (const key of ['system', 'system_file'] as const) {
      if (a[key]?.includes('${')) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'system prompts are static (prompt cache); put dynamic content in "input"',
        });
      }
    }
  });

export type LlmActionConfig = z.infer<typeof LlmAction>;

export async function runLlm(action: unknown, ctx: ActionContext): Promise<JsonValue> {
  const cfg = LlmAction.parse(action);
  const llm = ctx.llm;
  if (llm === undefined) {
    throw new NonRetryableError('no llm service is configured');
  }
  const provider = cfg.provider ?? llm.defaults.provider;
  const model = cfg.model ?? llm.defaults.model;
  if (provider === undefined) {
    throw new NonRetryableError('no provider: set action.provider or defaults.llm.provider');
  }
  if (model === undefined) {
    throw new NonRetryableError('no model: set action.model or defaults.llm.model');
  }
  const maxTokens = cfg.max_tokens ?? llm.defaults.max_tokens;
  const system =
    cfg.system ?? (cfg.system_file === undefined ? undefined : llm.readSystemFile(cfg.system_file));
  const input = ctx.renderText(cfg.input);
  const caps = [cfg.budget?.max_usd, ctx.task.budget?.max_usd].filter((x) => x !== undefined);
  const maxUsd = caps.length === 0 ? undefined : Math.min(...caps);
  const res = await llm.call(
    {
      provider,
      model,
      system,
      input,
      outputSchema: cfg.output_schema,
      maxTokens,
      effort: cfg.effort ?? llm.defaults.effort,
      maxUsd,
    },
    { run: ctx.run, task: ctx.task.name, signal: ctx.signal, log: ctx.log },
  );
  if (res.stopReason === 'max_tokens') {
    throw new NonRetryableError(
      `output truncated at max_tokens ${String(maxTokens)}; raise it or shorten the task`,
    );
  }
  if (res.stopReason === 'refusal') {
    throw new NonRetryableError('the model refused the request');
  }
  return cfg.output_schema === undefined ? { text: res.text ?? '' } : res.output;
}
