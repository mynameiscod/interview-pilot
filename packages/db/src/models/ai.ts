import {
  AiCallOutcome,
  AiCapability,
  AiFeature,
  AiProviderKey,
  Currency,
  PricingUnit,
  PromptRole,
  PromptStatus,
  ProviderHealthStatus,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type {
  AiCallOutcome as AiCallOutcomeT,
  AiCapability as AiCapabilityT,
  AiFeature as AiFeatureT,
  AiProviderKey as AiProviderKeyT,
  Currency as CurrencyT,
  PricingUnit as PricingUnitT,
  PromptRole as PromptRoleT,
  PromptStatus as PromptStatusT,
  ProviderHealthStatus as ProviderHealthStatusT,
} from '@cbi/shared-types';

// Record types are declared explicitly: InferSchemaType on these nested
// schemas exhausts the TypeScript checker.

export interface AiCredentialRecord {
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
  last4: string;
  updatedAt: Date;
}

export interface AiProviderRecord {
  _id: Types.ObjectId;
  key: AiProviderKeyT;
  displayName: string;
  enabled: boolean;
  credential: AiCredentialRecord | null;
  region: string | null;
  baseUrl: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiPriceRecord {
  unit: PricingUnitT;
  pricePerUnitMicros: number;
  currency: CurrencyT;
  effectiveFrom: Date;
  addedBy?: Types.ObjectId | null;
}

export interface AiModelRecord {
  _id: Types.ObjectId;
  providerId: Types.ObjectId;
  modelId: string;
  displayName: string;
  capabilities: AiCapabilityT[];
  enabled: boolean;
  languages: string[];
  params: {
    temperature: number | null;
    maxOutputTokens: number;
    timeoutMs: number;
    retries: number;
    concurrency: number;
  };
  pricing: AiPriceRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AiRouteRecord {
  _id: Types.ObjectId;
  feature: AiFeatureT;
  active: boolean;
  chain: { modelId: Types.ObjectId; priority: number }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AiUsageDoc {
  _id: Types.ObjectId;
  at: Date;
  feature: AiFeatureT;
  provider: AiProviderKeyT;
  providerId: Types.ObjectId;
  modelRef: Types.ObjectId;
  model: string;
  servedModel: string | null;
  sessionId: string | null;
  userId: Types.ObjectId | null;
  correlationId: string | null;
  promptKey: string | null;
  promptVersion: number | null;
  units: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    requests: number;
    durationSec?: number;
    audioSec?: number;
    characters?: number;
    images?: number;
  };
  latencyMs: number;
  attempt: number;
  outcome: AiCallOutcomeT;
  errorCode: string | null;
  priceSnapshot: { currency: CurrencyT; entries: AiPriceRecord[] } | null;
  costMicros: number;
  currency: CurrencyT;
}

export interface ProviderHealthRecord {
  _id: Types.ObjectId;
  provider: AiProviderKeyT;
  modelRef: Types.ObjectId;
  model: string;
  window: string;
  windowStart: Date;
  calls: number;
  failures: number;
  errorRate: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  status: ProviderHealthStatusT;
}

export interface PromptTemplateRecord {
  _id: Types.ObjectId;
  key: string;
  version: number;
  locale: string;
  feature: AiFeatureT;
  status: PromptStatusT;
  messages: { role: PromptRoleT; content: string }[];
  variables: string[];
  notes: string | null;
  contentHash: string;
  createdBy: Types.ObjectId | null;
  activatedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
}

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

const APPEND_ONLY_OPS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

// ---- aiProviders ---------------------------------------------------------------

const credentialSchema = new Schema(
  {
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    keyId: { type: String, required: true },
    last4: { type: String, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

/** One row per adapter. The API key is AES-256-GCM encrypted; only last4 leaves the server. */
const aiProviderSchema = new Schema<AiProviderRecord>(
  {
    key: { type: String, enum: AiProviderKey.options, required: true },
    displayName: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: true },
    credential: { type: credentialSchema, default: null },
    region: { type: String, default: null },
    baseUrl: { type: String, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true, collection: 'aiProviders' },
);
aiProviderSchema.index({ key: 1 }, { unique: true });

export const AiProviderModel = model<AiProviderRecord>('AiProvider', aiProviderSchema);

// ---- aiModels ------------------------------------------------------------------

const priceSchema = new Schema(
  {
    unit: { type: String, enum: PricingUnit.options, required: true },
    pricePerUnitMicros: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: Currency.options, required: true },
    effectiveFrom: { type: Date, required: true },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
);

const aiModelSchema = new Schema<AiModelRecord>(
  {
    providerId: { type: Schema.Types.ObjectId, ref: 'AiProvider', required: true },
    /** The provider's model id, e.g. `claude-opus-5`. */
    modelId: { type: String, required: true },
    displayName: { type: String, required: true },
    capabilities: { type: [String], enum: AiCapability.options, required: true },
    enabled: { type: Boolean, required: true, default: true },
    languages: { type: [String], default: [] },
    params: {
      temperature: { type: Number, default: null },
      maxOutputTokens: { type: Number, required: true },
      timeoutMs: { type: Number, required: true },
      retries: { type: Number, required: true },
      concurrency: { type: Number, required: true },
    },
    /** Effective-dated and append-only; usage rows copy the entries in force. */
    pricing: { type: [priceSchema], default: [] },
  },
  { timestamps: true, collection: 'aiModels' },
);
aiModelSchema.index({ providerId: 1, modelId: 1 }, { unique: true });

export const AiModelModel = model<AiModelRecord>('AiModel', aiModelSchema);

// ---- aiRoutes ------------------------------------------------------------------

const aiRouteSchema = new Schema<AiRouteRecord>(
  {
    feature: { type: String, enum: AiFeature.options, required: true },
    active: { type: Boolean, required: true, default: true },
    chain: {
      type: [
        new Schema(
          {
            modelId: { type: Schema.Types.ObjectId, ref: 'AiModel', required: true },
            priority: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, collection: 'aiRoutes' },
);
aiRouteSchema.index({ feature: 1 }, { unique: true });

export const AiRouteModel = model<AiRouteRecord>('AiRoute', aiRouteSchema);

// ---- aiUsage (append-only cost ledger) -------------------------------------------

const aiUsageSchema = new Schema<AiUsageDoc>(
  {
    at: { type: Date, required: true },
    feature: { type: String, enum: AiFeature.options, required: true },
    provider: { type: String, enum: AiProviderKey.options, required: true },
    providerId: { type: Schema.Types.ObjectId, ref: 'AiProvider', required: true },
    modelRef: { type: Schema.Types.ObjectId, ref: 'AiModel', required: true },
    model: { type: String, required: true },
    servedModel: { type: String, default: null },
    sessionId: { type: String, default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    correlationId: { type: String, default: null },
    promptKey: { type: String, default: null },
    promptVersion: { type: Number, default: null },
    units: {
      inputTokens: { type: Number, required: true },
      cachedInputTokens: { type: Number, required: true },
      outputTokens: { type: Number, required: true },
      requests: { type: Number, required: true },
      durationSec: { type: Number },
      audioSec: { type: Number },
      characters: { type: Number },
      images: { type: Number },
    },
    latencyMs: { type: Number, required: true },
    attempt: { type: Number, required: true },
    outcome: { type: String, enum: AiCallOutcome.options, required: true },
    errorCode: { type: String, default: null },
    /** Prices in force at call time; later price changes never re-price history. */
    priceSnapshot: {
      type: new Schema(
        {
          currency: { type: String, enum: Currency.options, required: true },
          entries: { type: [priceSchema], default: [] },
        },
        { _id: false },
      ),
      default: null,
    },
    costMicros: { type: Number, required: true },
    currency: { type: String, enum: Currency.options, required: true },
  },
  { collection: 'aiUsage', versionKey: false },
);
aiUsageSchema.index(
  { sessionId: 1 },
  { partialFilterExpression: { sessionId: { $type: 'string' } } },
);
aiUsageSchema.index({ at: -1 });
aiUsageSchema.index({ provider: 1, model: 1, at: -1 });
aiUsageSchema.index({ feature: 1, at: -1 });
aiUsageSchema.index({ modelRef: 1, at: -1 });
for (const op of APPEND_ONLY_OPS) {
  aiUsageSchema.pre(op, function () {
    throw new Error('aiUsage is append-only');
  });
}

export const AiUsageModel = model<AiUsageDoc>('AiUsage', aiUsageSchema);

// ---- providerHealth (rolled up by the worker) -------------------------------------

const providerHealthSchema = new Schema<ProviderHealthRecord>(
  {
    provider: { type: String, enum: AiProviderKey.options, required: true },
    modelRef: { type: Schema.Types.ObjectId, ref: 'AiModel', required: true },
    model: { type: String, required: true },
    /** Window length label, e.g. `5m`. */
    window: { type: String, required: true },
    windowStart: { type: Date, required: true },
    calls: { type: Number, required: true },
    failures: { type: Number, required: true },
    errorRate: { type: Number, required: true },
    p50LatencyMs: { type: Number, default: null },
    p95LatencyMs: { type: Number, default: null },
    status: { type: String, enum: ProviderHealthStatus.options, required: true },
  },
  { collection: 'providerHealth', versionKey: false },
);
providerHealthSchema.index({ modelRef: 1, window: 1, windowStart: -1 }, { unique: true });
providerHealthSchema.index({ provider: 1, model: 1, window: 1 });
// Health history is kept for 30 days.
providerHealthSchema.index({ windowStart: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const ProviderHealthModel = model<ProviderHealthRecord>(
  'ProviderHealth',
  providerHealthSchema,
);

// ---- promptTemplates (versioned; content immutable) -------------------------------

const promptTemplateSchema = new Schema<PromptTemplateRecord>(
  {
    key: { type: String, required: true },
    version: { type: Number, required: true },
    locale: { type: String, required: true },
    feature: { type: String, enum: AiFeature.options, required: true },
    status: { type: String, enum: PromptStatus.options, required: true, default: 'DRAFT' },
    messages: {
      type: [
        new Schema(
          {
            role: { type: String, enum: PromptRole.options, required: true },
            content: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      required: true,
    },
    variables: { type: [String], default: [] },
    notes: { type: String, default: null },
    contentHash: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activatedAt: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'promptTemplates' },
);
promptTemplateSchema.index({ key: 1, version: 1, locale: 1 }, { unique: true });
// At most one ACTIVE version per key and locale.
promptTemplateSchema.index(
  { key: 1, locale: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'ACTIVE' },
    name: 'one_active_per_key_locale',
  },
);
promptTemplateSchema.index({ feature: 1, status: 1 });

/** Only lifecycle fields may change; content is fixed once a version exists. */
const PROMPT_MUTABLE = new Set(['status', 'activatedAt', 'retiredAt']);
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  promptTemplateSchema.pre(op, function () {
    const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
    const fields = Object.entries(update).flatMap(([k, v]) =>
      k.startsWith('$') ? Object.keys((v ?? {}) as object) : [k],
    );
    const forbidden = fields.filter((f) => !PROMPT_MUTABLE.has(f));
    if (forbidden.length > 0) {
      throw new Error(`promptTemplates content is immutable (attempted: ${forbidden.join(', ')})`);
    }
  });
}
for (const op of [
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  promptTemplateSchema.pre(op, function () {
    throw new Error('promptTemplates versions cannot be replaced or deleted');
  });
}

export const PromptTemplateModel = model<PromptTemplateRecord>(
  'PromptTemplate',
  promptTemplateSchema,
);
