import { CodingLanguage } from '@cbi/shared-types';
import type {
  CodeRunResult,
  CodingLanguage as CodingLanguageT,
  ProblemContent,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

// ---- problems (append-only versions per key) --------------------------------------------------

export interface ProblemRecord {
  _id: Types.ObjectId;
  key: string;
  version: number;
  active: boolean;
  /** Includes hidden tests: never sent to candidates. */
  content: ProblemContent;
  createdBy: Types.ObjectId | null;
  reason: string | null;
  createdAt: Date;
}

const problemSchema = new Schema<ProblemRecord>(
  {
    key: { type: String, required: true },
    version: { type: Number, required: true },
    active: { type: Boolean, required: true, default: false },
    content: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'problems', minimize: false },
);
problemSchema.index({ key: 1, version: 1 }, { unique: true });
problemSchema.index(
  { key: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'one_active_per_key' },
);
problemSchema.index({ active: 1, 'content.difficulty': 1 });
// Attempts reference exact versions, so content never changes: only `active` may be updated.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  problemSchema.pre(op, function () {
    const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
    const fields = Object.entries(update).flatMap(([k, v]) =>
      k.startsWith('$') ? Object.keys((v ?? {}) as object) : [k],
    );
    const forbidden = fields.filter((f) => f !== 'active');
    if (forbidden.length)
      throw new Error(`problem versions are immutable (attempted: ${forbidden.join(', ')})`);
  });
}

export const ProblemModel = model<ProblemRecord>('Problem', problemSchema);

// ---- codingAttempts (one per coding question) -----------------------------------------------

export interface CodingSubmissionRecord {
  at: Date;
  language: CodingLanguageT;
  code: string;
  result: CodeRunResult | null;
  judgeUnavailable: boolean;
  /** AUTO: judged by the worker because time ran out before the candidate submitted. */
  source: 'CANDIDATE' | 'AUTO';
}

export interface CodingAttemptRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  questionId: string;
  problemId: Types.ObjectId;
  language: CodingLanguageT;
  code: string;
  autosavedAt: Date | null;
  runCount: number;
  lastRun: CodeRunResult | null;
  submission: CodingSubmissionRecord | null;
  createdAt: Date;
  updatedAt: Date;
}

const codingAttemptSchema = new Schema<CodingAttemptRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    questionId: { type: String, required: true },
    problemId: { type: Schema.Types.ObjectId, ref: 'Problem', required: true },
    language: { type: String, enum: CodingLanguage.options, required: true },
    code: { type: String, default: '' },
    autosavedAt: { type: Date, default: null },
    runCount: { type: Number, default: 0 },
    lastRun: { type: Schema.Types.Mixed, default: null },
    submission: {
      type: new Schema<CodingSubmissionRecord>(
        {
          at: { type: Date, required: true },
          language: { type: String, enum: CodingLanguage.options, required: true },
          code: { type: String, required: true },
          result: { type: Schema.Types.Mixed, default: null },
          judgeUnavailable: { type: Boolean, required: true },
          source: { type: String, enum: ['CANDIDATE', 'AUTO'], required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true, collection: 'codingAttempts', minimize: false },
);
codingAttemptSchema.index({ sessionId: 1, questionId: 1 }, { unique: true });
codingAttemptSchema.index({ userId: 1, problemId: 1, createdAt: -1 });

export const CodingAttemptModel = model<CodingAttemptRecord>('CodingAttempt', codingAttemptSchema);
