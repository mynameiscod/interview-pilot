import { z } from 'zod';

/**
 * AI provider layer contracts (Phase 2). Providers, models and routes are
 * configured by admins at runtime; application code only ever asks for a
 * **feature** and the router decides which model serves it.
 */

export const AiCapability = z.enum([
  'LLM',
  'STT',
  'TTS',
  'REALTIME',
  'EMBEDDING',
  'OCR',
  'TRANSLATION',
]);
export type AiCapability = z.infer<typeof AiCapability>;

/**
 * Adapter keys. `mock` is deterministic, clearly labelled and only
 * available when APP_ENV is development/test and AI_MOCK_MODE=true.
 */
export const AiProviderKey = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'deepgram',
  'elevenlabs',
  'mock',
]);
export type AiProviderKey = z.infer<typeof AiProviderKey>;

/**
 * Every AI call names the product feature it serves. Routes, usage and cost
 * reporting are keyed by feature. Add features here; never rename one.
 */
export const AiFeature = z.enum([
  'role.analyze',
  'resume.structure',
  'jd.structure',
  'blueprint.generate',
  'interview.question',
  'interview.assessTurn',
  'evaluation.extractEvidence',
  'evaluation.scoreDimension',
  'report.recommendations',
  'stt.live',
  'tts.live',
  'ocr.document',
  /** Connectivity checks from the admin console. Never routed. */
  'admin.test',
]);
export type AiFeature = z.infer<typeof AiFeature>;

/** The capability each routable feature needs from a model. */
export const AI_FEATURE_CAPABILITY: Readonly<Record<AiFeature, AiCapability>> = {
  'role.analyze': 'LLM',
  'resume.structure': 'LLM',
  'jd.structure': 'LLM',
  'blueprint.generate': 'LLM',
  'interview.question': 'LLM',
  'interview.assessTurn': 'LLM',
  'evaluation.extractEvidence': 'LLM',
  'evaluation.scoreDimension': 'LLM',
  'report.recommendations': 'LLM',
  'stt.live': 'STT',
  'tts.live': 'TTS',
  'ocr.document': 'OCR',
  'admin.test': 'LLM',
};

/**
 * Pricing units: a price is "currency per unit", e.g. PER_1M_INPUT_TOKENS =
 * USD per 1M input tokens. `calculateCost` in @cbi/ai-core maps each unit to
 * the usage it bills.
 */
export const PricingUnit = z.enum([
  'PER_1M_INPUT_TOKENS',
  'PER_1M_CACHED_INPUT_TOKENS',
  'PER_1M_OUTPUT_TOKENS',
  'PER_MINUTE',
  'PER_AUDIO_MINUTE',
  'PER_STT_HOUR',
  'PER_1M_CHARACTERS',
  'PER_IMAGE',
  'PER_REQUEST',
]);
export type PricingUnit = z.infer<typeof PricingUnit>;

export const Currency = z.enum(['USD', 'INR']);
export type Currency = z.infer<typeof Currency>;

/**
 * Money is stored as integer **micro-units** (1/1,000,000 of the currency's
 * major unit). A single LLM call routinely costs a fraction of a cent, so
 * minor units (cents/paise) would round most calls to zero.
 */
export const MICROS_PER_UNIT = 1_000_000;

/** Accepts "5", "0.15", "12.500000" (≤ 6 decimals); converts to integer micros. */
export const DecimalPrice = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, 'Use a decimal amount with at most 6 decimal places')
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return Number(whole) * MICROS_PER_UNIT + Number(fraction.padEnd(6, '0'));
  });

export const PriceEntry = z.object({
  unit: PricingUnit,
  pricePerUnitMicros: z.number().int().min(0),
  currency: Currency,
  effectiveFrom: z.iso.datetime(),
});
export type PriceEntry = z.infer<typeof PriceEntry>;

const modelParamFields = {
  /** Null for models that reject sampling parameters (e.g. Claude Opus 5). */
  temperature: z.number().min(0).max(2).nullable(),
  maxOutputTokens: z.number().int().min(16).max(128_000),
  timeoutMs: z.number().int().min(1000).max(600_000),
  /** Retries on the same model for transient failures (not counting the first attempt). */
  retries: z.number().int().min(0).max(5),
  /** Maximum in-flight calls to this model across all API/worker replicas. */
  concurrency: z.number().int().min(1).max(500),
  /** TTS models: the provider's voice id (null = the adapter's default voice). */
  voice: z.string().trim().min(1).max(100).nullable(),
};

export const AiModelParams = z.object({
  temperature: modelParamFields.temperature.default(null),
  maxOutputTokens: modelParamFields.maxOutputTokens.default(4096),
  timeoutMs: modelParamFields.timeoutMs.default(60_000),
  retries: modelParamFields.retries.default(1),
  concurrency: modelParamFields.concurrency.default(20),
  voice: modelParamFields.voice.optional(),
});
export type AiModelParams = z.infer<typeof AiModelParams>;

/** A partial update: absent fields keep their current value (no defaults applied). */
export const AiModelParamsPatch = z.object(modelParamFields).partial();
export type AiModelParamsPatch = z.infer<typeof AiModelParamsPatch>;

export const AiCallOutcome = z.enum([
  'SUCCESS',
  'TIMEOUT',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'AUTH_ERROR',
  'BAD_REQUEST',
  'REFUSED',
  'INVALID_OUTPUT',
  'NETWORK_ERROR',
  'ABORTED',
]);
export type AiCallOutcome = z.infer<typeof AiCallOutcome>;

export const BreakerState = z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']);
export type BreakerState = z.infer<typeof BreakerState>;

export const ProviderHealthStatus = z.enum(['HEALTHY', 'DEGRADED', 'DOWN', 'IDLE']);
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatus>;

// ---- Admin: providers --------------------------------------------------------

export const AiProviderSummary = z.object({
  id: z.string(),
  key: AiProviderKey,
  displayName: z.string(),
  enabled: z.boolean(),
  /** False when the adapter cannot run in this environment (e.g. mock outside dev/test). */
  available: z.boolean(),
  credential: z
    .object({
      last4: z.string(),
      keyId: z.string(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  baseUrl: z.string().nullable(),
  region: z.string().nullable(),
  notes: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type AiProviderSummary = z.infer<typeof AiProviderSummary>;

const reason = z.string().trim().min(3).max(300);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const UpdateAiProviderBody = z.object({
  enabled: z.boolean().optional(),
  displayName: z.string().trim().min(2).max(60).optional(),
  baseUrl: z
    .url({ protocol: /^https$/ })
    .nullable()
    .optional(),
  region: optionalText(40),
  notes: optionalText(500),
});
export type UpdateAiProviderBody = z.infer<typeof UpdateAiProviderBody>;

export const SetAiProviderCredentialBody = z.object({
  apiKey: z.string().trim().min(8).max(512),
  reason,
});
export type SetAiProviderCredentialBody = z.infer<typeof SetAiProviderCredentialBody>;

export const RemoveAiProviderCredentialBody = z.object({ reason });
export type RemoveAiProviderCredentialBody = z.infer<typeof RemoveAiProviderCredentialBody>;

// ---- Admin: models -----------------------------------------------------------

export const AiModelSummary = z.object({
  id: z.string(),
  providerId: z.string(),
  providerKey: AiProviderKey,
  modelId: z.string(),
  displayName: z.string(),
  capabilities: z.array(AiCapability),
  enabled: z.boolean(),
  languages: z.array(z.string()),
  params: AiModelParams,
  pricing: z.array(PriceEntry),
  /** Pricing in force right now, one entry per unit. */
  currentPricing: z.array(PriceEntry),
  updatedAt: z.iso.datetime(),
});
export type AiModelSummary = z.infer<typeof AiModelSummary>;

const modelIdString = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[A-Za-z0-9._:/@-]+$/, 'Use the provider model id, e.g. claude-opus-5');

export const CreateAiModelBody = z.object({
  providerId: z.string().min(1).max(64),
  modelId: modelIdString,
  displayName: z.string().trim().min(2).max(80),
  capabilities: z.array(AiCapability).min(1),
  languages: z.array(z.string().trim().min(2).max(12)).max(50).default([]),
  params: AiModelParamsPatch.default({}),
});
export type CreateAiModelBody = z.infer<typeof CreateAiModelBody>;

export const UpdateAiModelBody = z.object({
  displayName: z.string().trim().min(2).max(80).optional(),
  enabled: z.boolean().optional(),
  languages: z.array(z.string().trim().min(2).max(12)).max(50).optional(),
  params: AiModelParamsPatch.optional(),
});
export type UpdateAiModelBody = z.infer<typeof UpdateAiModelBody>;

/**
 * Prices are effective-dated and append-only: a change is a new entry with a
 * later `effectiveFrom`. Usage rows keep the snapshot that applied at call time.
 */
export const AddAiModelPriceBody = z.object({
  unit: PricingUnit,
  /** Major currency units per pricing unit, as a decimal string: "5.00". */
  price: DecimalPrice,
  currency: Currency.default('USD'),
  /** Defaults to now. Past dates are refused so history cannot be rewritten. */
  effectiveFrom: z.iso.datetime().optional(),
  reason,
});
export type AddAiModelPriceBody = z.infer<typeof AddAiModelPriceBody>;

export const TestAiModelResponse = z.object({
  ok: z.boolean(),
  outcome: AiCallOutcome,
  latencyMs: z.number().int(),
  servedModel: z.string().nullable(),
  sample: z.string().nullable(),
  message: z.string().nullable(),
});
export type TestAiModelResponse = z.infer<typeof TestAiModelResponse>;

// ---- Admin: routes -----------------------------------------------------------

export const AiRouteSummary = z.object({
  feature: AiFeature,
  capability: AiCapability,
  active: z.boolean(),
  chain: z.array(
    z.object({
      modelId: z.string(),
      priority: z.number().int(),
      label: z.string(),
    }),
  ),
  updatedAt: z.iso.datetime().nullable(),
});
export type AiRouteSummary = z.infer<typeof AiRouteSummary>;

export const UpsertAiRouteBody = z.object({
  active: z.boolean(),
  /** Ordered by priority ascending; the first healthy model serves the call. */
  chain: z
    .array(z.object({ modelId: z.string().min(1).max(64), priority: z.number().int().min(0) }))
    .max(6)
    .refine((chain) => new Set(chain.map((c) => c.modelId)).size === chain.length, {
      message: 'A model can appear only once in a chain',
    }),
  reason,
});
export type UpsertAiRouteBody = z.infer<typeof UpsertAiRouteBody>;

// ---- Admin: usage, cost, health ----------------------------------------------

export const AiUsageGroupBy = z.enum(['feature', 'model', 'day']);
export type AiUsageGroupBy = z.infer<typeof AiUsageGroupBy>;

export const AiUsageQuery = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    groupBy: AiUsageGroupBy.default('feature'),
    feature: AiFeature.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: '`from` must be before `to`' });
export type AiUsageQuery = z.infer<typeof AiUsageQuery>;

export const AiUsageRow = z.object({
  key: z.string(),
  calls: z.number().int(),
  failures: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** Keyed by currency; micro-units. */
  costMicros: z.record(z.string(), z.number().int()),
  avgLatencyMs: z.number().int(),
});
export type AiUsageRow = z.infer<typeof AiUsageRow>;

export const AiUsageReport = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  groupBy: AiUsageGroupBy,
  rows: z.array(AiUsageRow),
  totals: AiUsageRow,
});
export type AiUsageReport = z.infer<typeof AiUsageReport>;

export const AiUsageEntry = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  feature: AiFeature,
  provider: AiProviderKey,
  model: z.string(),
  servedModel: z.string().nullable(),
  outcome: AiCallOutcome,
  errorCode: z.string().nullable(),
  attempt: z.number().int(),
  latencyMs: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
  currency: Currency,
  correlationId: z.string().nullable(),
  promptKey: z.string().nullable(),
  promptVersion: z.number().int().nullable(),
});
export type AiUsageEntry = z.infer<typeof AiUsageEntry>;

export const AiUsageEntriesQuery = z.object({
  feature: AiFeature.optional(),
  outcome: AiCallOutcome.optional(),
  before: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AiUsageEntriesQuery = z.infer<typeof AiUsageEntriesQuery>;

export const AiUsageEntriesPage = z.object({
  items: z.array(AiUsageEntry),
  nextCursor: z.string().nullable(),
});
export type AiUsageEntriesPage = z.infer<typeof AiUsageEntriesPage>;

export const AiModelHealth = z.object({
  modelId: z.string(),
  provider: AiProviderKey,
  model: z.string(),
  breaker: BreakerState,
  status: ProviderHealthStatus,
  windowStart: z.iso.datetime().nullable(),
  calls: z.number().int(),
  errorRate: z.number().min(0).max(1),
  p50LatencyMs: z.number().int().nullable(),
  p95LatencyMs: z.number().int().nullable(),
});
export type AiModelHealth = z.infer<typeof AiModelHealth>;

// ---- Admin: prompt registry --------------------------------------------------

export const PromptStatus = z.enum(['DRAFT', 'ACTIVE', 'RETIRED']);
export type PromptStatus = z.infer<typeof PromptStatus>;

export const PromptRole = z.enum(['system', 'user']);
export type PromptRole = z.infer<typeof PromptRole>;

const promptKey = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(
    /^[a-z][a-z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/,
    'Use a dotted key such as interview.question',
  );

export const PromptTemplateSummary = z.object({
  id: z.string(),
  key: z.string(),
  version: z.number().int(),
  locale: z.string(),
  feature: AiFeature,
  status: PromptStatus,
  messages: z.array(z.object({ role: PromptRole, content: z.string() })),
  variables: z.array(z.string()),
  notes: z.string().nullable(),
  contentHash: z.string(),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
});
export type PromptTemplateSummary = z.infer<typeof PromptTemplateSummary>;

/** Creates the next version of `key`+`locale` as a DRAFT. Content is immutable afterwards. */
export const CreatePromptVersionBody = z.object({
  key: promptKey,
  locale: z.string().trim().min(2).max(12).default('en'),
  feature: AiFeature,
  messages: z
    .array(z.object({ role: PromptRole, content: z.string().min(1).max(40_000) }))
    .min(1)
    .max(8),
  notes: optionalText(1000),
});
export type CreatePromptVersionBody = z.infer<typeof CreatePromptVersionBody>;

export const ActivatePromptBody = z.object({ reason });
export type ActivatePromptBody = z.infer<typeof ActivatePromptBody>;

export const PromptListQuery = z.object({
  key: z.string().max(80).optional(),
  status: PromptStatus.optional(),
});
export type PromptListQuery = z.infer<typeof PromptListQuery>;
