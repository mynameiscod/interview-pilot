import type { DesignPromptContent, Diagram, DesignNotes } from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

// ---- designPrompts (append-only versions per key) -----------------------------------------------

export interface DesignPromptRecord {
  _id: Types.ObjectId;
  key: string;
  version: number;
  active: boolean;
  /** Includes the considerations (the rubric): never sent to candidates. */
  content: DesignPromptContent;
  createdBy: Types.ObjectId | null;
  reason: string | null;
  /** The seed revision this version came from (null when an admin created it). */
  seedRevision: number | null;
  createdAt: Date;
}

const designPromptSchema = new Schema<DesignPromptRecord>(
  {
    key: { type: String, required: true },
    version: { type: Number, required: true },
    active: { type: Boolean, required: true, default: false },
    content: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null },
    seedRevision: { type: Number, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'designPrompts',
    minimize: false,
  },
);
designPromptSchema.index({ key: 1, version: 1 }, { unique: true });
designPromptSchema.index(
  { key: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'one_active_per_key' },
);
designPromptSchema.index({ active: 1, 'content.difficulty': 1 });
// Attempts reference exact versions, so content never changes: only `active` may be updated.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  designPromptSchema.pre(op, function () {
    const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
    const fields = Object.entries(update).flatMap(([k, v]) =>
      k.startsWith('$') ? Object.keys((v ?? {}) as object) : [k],
    );
    const forbidden = fields.filter((f) => f !== 'active');
    if (forbidden.length)
      throw new Error(`design prompt versions are immutable (attempted: ${forbidden.join(', ')})`);
  });
}

export const DesignPromptModel = model<DesignPromptRecord>('DesignPrompt', designPromptSchema);

// ---- designAttempts (one per design question) ---------------------------------------------------

export interface DesignAttemptRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  questionId: string;
  roundIdx: number;
  promptId: Types.ObjectId;
  notes: DesignNotes;
  diagram: Diagram;
  autosavedAt: Date | null;
  /** Set when the candidate submits; the design is read-only afterwards. */
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const designAttemptSchema = new Schema<DesignAttemptRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    questionId: { type: String, required: true },
    roundIdx: { type: Number, required: true },
    promptId: { type: Schema.Types.ObjectId, ref: 'DesignPrompt', required: true },
    notes: { type: Schema.Types.Mixed, required: true },
    diagram: { type: Schema.Types.Mixed, required: true },
    autosavedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'designAttempts', minimize: false },
);
designAttemptSchema.index({ sessionId: 1, questionId: 1 }, { unique: true });
designAttemptSchema.index({ userId: 1, promptId: 1, createdAt: -1 });

export const DesignAttemptModel = model<DesignAttemptRecord>('DesignAttempt', designAttemptSchema);
