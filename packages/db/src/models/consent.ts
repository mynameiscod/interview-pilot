import { ConsentLocale, ConsentType } from '@cbi/shared-types';
import type {
  ConsentLocale as ConsentLocaleT,
  ConsentType as ConsentTypeT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

// ---- consentTexts (append-only versions per type and locale) -------------------------------

export interface ConsentTextRecord {
  _id: Types.ObjectId;
  type: ConsentTypeT;
  locale: ConsentLocaleT;
  version: number;
  title: string;
  body: string;
  active: boolean;
  createdBy: Types.ObjectId | null;
  reason: string | null;
  createdAt: Date;
}

const consentTextSchema = new Schema<ConsentTextRecord>(
  {
    type: { type: String, enum: ConsentType.options, required: true },
    locale: { type: String, enum: ConsentLocale.options, required: true },
    version: { type: Number, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    active: { type: Boolean, required: true, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'consentTexts' },
);
consentTextSchema.index({ type: 1, locale: 1, version: 1 }, { unique: true });
consentTextSchema.index(
  { type: 1, locale: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'one_active_per_type_locale' },
);
// Texts a candidate agreed to must never change: only `active` may be updated.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  consentTextSchema.pre(op, function () {
    const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
    const fields = Object.entries(update).flatMap(([k, v]) =>
      k.startsWith('$') ? Object.keys((v ?? {}) as object) : [k],
    );
    const forbidden = fields.filter((f) => f !== 'active');
    if (forbidden.length)
      throw new Error(`consent texts are immutable (attempted: ${forbidden.join(', ')})`);
  });
}

export const ConsentTextModel = model<ConsentTextRecord>('ConsentText', consentTextSchema);

// ---- consents (every decision, append-only) --------------------------------------------------

export interface ConsentRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId | null;
  type: ConsentTypeT;
  consentTextId: Types.ObjectId;
  version: number;
  locale: ConsentLocaleT;
  accepted: boolean;
  at: Date;
  ipHash: string | null;
  userAgent: string | null;
}

const consentSchema = new Schema<ConsentRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', default: null },
    type: { type: String, enum: ConsentType.options, required: true },
    consentTextId: { type: Schema.Types.ObjectId, ref: 'ConsentText', required: true },
    version: { type: Number, required: true },
    locale: { type: String, enum: ConsentLocale.options, required: true },
    accepted: { type: Boolean, required: true },
    at: { type: Date, required: true },
    ipHash: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { collection: 'consents', versionKey: false },
);
consentSchema.index({ userId: 1, type: 1, at: -1 });
consentSchema.index({ sessionId: 1 });
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  consentSchema.pre(op, function () {
    throw new Error('consent records are append-only');
  });
}

export const ConsentModel = model<ConsentRecord>('Consent', consentSchema);
