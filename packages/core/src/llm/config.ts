import { z } from 'zod';

import { collectTemplateRefs, isTemplate } from '../expr/template.js';

const NAME = /^[a-z][a-z0-9_]*$/;

export const PROVIDER_TYPES = ['anthropic', 'openai', 'openrouter'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** `output_config.effort` on Sonnet/Opus 5 and `reasoning.effort` elsewhere; dropped on models without it. */
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

const usdPerMtok = z.number().nonnegative();

/**
 * One entry of `providers:` in agent.yaml (ARCHITECTURE §7). The key is a secret reference,
 * never a literal, so it is resolved per call and never written anywhere.
 */
export const ProviderConfig = z
  .strictObject({
    type: z.enum(PROVIDER_TYPES),
    /** Exactly one whole `${secrets.<name>}`. */
    api_key: z.string().min(1),
    /** Overrides the provider type's default endpoint (a proxy, an OpenAI-compatible server). */
    base_url: z.url().optional(),
    /** Extra HTTP headers (OpenRouter's `HTTP-Referer`/`X-Title`); values may use `${secrets.x}`/`${env.X}`. */
    headers: z.record(z.string().min(1), z.string()).default({}),
  })
  .superRefine((p, ctx) => {
    const key = collectTemplateRefs(p.api_key);
    const keyOk =
      isTemplate(p.api_key) &&
      key.errors.length === 0 &&
      key.wholeSecrets.length === 0 &&
      key.secrets.length === 1 &&
      key.roots.size === 1 &&
      /^\s*\$\{\s*secrets\.[A-Za-z][A-Za-z0-9_]*\s*\}\s*$/.test(p.api_key);
    if (!keyOk) {
      ctx.addIssue({
        code: 'custom',
        path: ['api_key'],
        message: 'api_key must be a single secret reference like "${secrets.anthropic_api_key}"',
      });
    }
    const headers = collectTemplateRefs(p.headers);
    for (const e of headers.errors) {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: `${e.message} (in "${e.template}")`,
      });
    }
    for (const t of headers.wholeSecrets) {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: `reference secrets by name (secrets.<name>), not as a whole (in "${t}")`,
      });
    }
    for (const root of headers.roots) {
      if (root !== 'secrets' && root !== 'env') {
        ctx.addIssue({
          code: 'custom',
          path: ['headers'],
          message: `only \${secrets.<name>} and \${env.<VAR>} are available here, not "${root}"`,
        });
      }
    }
  });

export type ProviderConfigParsed = z.infer<typeof ProviderConfig>;

export const Providers = z
  .record(z.string().regex(NAME, 'provider names are [a-z][a-z0-9_]*'), ProviderConfig)
  .default({});
export type ProvidersConfig = z.infer<typeof Providers>;

/** USD per million tokens. A missing cache price falls back to `input`, which never under-charges. */
export const ModelPrice = z.strictObject({
  input: usdPerMtok,
  output: usdPerMtok,
  cache_read: usdPerMtok.optional(),
  cache_write: usdPerMtok.optional(),
});
export type ModelPriceConfig = z.infer<typeof ModelPrice>;

/**
 * `pricing:` in agent.yaml: overrides merged field by field over the built-in table, so
 * `{ claude-sonnet-5: { output: 12 } }` changes one number. A model the table does not know
 * needs at least `input` and `output` (checked by `resolvePricing`).
 */
export const Pricing = z.record(z.string().min(1), ModelPrice.partial()).default({});
export type PricingConfig = z.infer<typeof Pricing>;

/** `defaults.llm` in agent.yaml: what an `llm` action falls back to. */
export const LlmDefaults = z
  .strictObject({
    provider: z.string().regex(NAME, 'provider names are [a-z][a-z0-9_]*').optional(),
    model: z.string().min(1).optional(),
    max_tokens: z.number().int().positive().max(128_000).default(1024),
    effort: z.enum(EFFORTS).optional(),
  })
  .prefault({});
export type LlmDefaultsConfig = z.infer<typeof LlmDefaults>;

/** TypeSafe's Jev on OpenRouter: the classification model a `decide` action uses unless told otherwise. */
export const DEFAULT_DECIDE_MODEL = 'typesafe/jev-1.13';

/** `defaults.decide` in agent.yaml: what a `decide` action falls back to (ARCHITECTURE §5.3). */
export const DecideDefaults = z
  .strictObject({
    /** Must name an `openrouter` provider: only OpenRouter serves the Decisions API. */
    provider: z.string().regex(NAME, 'provider names are [a-z][a-z0-9_]*').optional(),
    model: z.string().min(1).default(DEFAULT_DECIDE_MODEL),
  })
  .prefault({});
export type DecideDefaultsConfig = z.infer<typeof DecideDefaults>;

/** Per run (`budget:` on a task or an `llm`/`decide` action). The smaller of the two applies. */
export const Budget = z.strictObject({ max_usd: z.number().positive() });
export type BudgetConfig = z.infer<typeof Budget>;

/** `budgets:` in agent.yaml: the global circuit breaker (ARCHITECTURE §9). */
export const Budgets = z.strictObject({ daily_usd: z.number().positive().optional() }).prefault({});
export type BudgetsConfig = z.infer<typeof Budgets>;
