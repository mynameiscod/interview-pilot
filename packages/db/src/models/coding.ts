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
  /**
   * The seed revision this version was created from (null when an admin
   * created it). A newer seed revision adds a version only while every
   * version of the key came from the seed.
   */
  seedRevision?: number | null;
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
    seedRevision: { type: Number, default: null },
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
  /** "Run with my input" runs (never tests). Absent on older attempts. */
  customRunCount?: number;
  lastRun: CodeRunResult | null;
  submission: CodingSubmissionRecord | null;
  /** AI-assisted rounds: the whole assistant conversation, kept for evaluation. */
  assistant?: AssistantRecord | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssistantMessageRecord {
  role: 'CANDIDATE' | 'ASSISTANT';
  text: string;
  at: Date;
  unavailable: boolean;
  redacted: boolean;
  /** The code as it was when the candidate asked (candidate messages only). */
  codeSnapshot: string | null;
  model: string | null;
  promptVersion: number | null;
}

export interface AssistantRecord {
  /** Candidate messages the assistant answered (an unavailable reply does not count). */
  turnsUsed: number;
  messages: AssistantMessageRecord[];
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
    customRunCount: { type: Number, default: 0 },
    // Messages are appended with $push; the reply cap keeps the document small.
    assistant: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: 'codingAttempts', minimize: false },
);
codingAttemptSchema.index({ sessionId: 1, questionId: 1 }, { unique: true });
codingAttemptSchema.index({ userId: 1, problemId: 1, createdAt: -1 });
// Code similarity: the other submissions to the same problem.
codingAttemptSchema.index({ problemId: 1, sessionId: 1 });

export const CodingAttemptModel = model<CodingAttemptRecord>('CodingAttempt', codingAttemptSchema);

// ---- codeSimilarityFlags (integrity observations, never scored) -------------------------------

/**
 * Two campaign submissions to the same problem whose normalised token
 * fingerprints overlap above the threshold. An observation for reviewers:
 * it never changes a score. One record per pair (ids in sorted order).
 */
export interface CodeSimilarityFlagRecord {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  problemKey: string;
  problemTitle: string;
  /** The pair, `a` < `b` by attempt id. */
  a: { attemptId: Types.ObjectId; sessionId: Types.ObjectId; userId: Types.ObjectId };
  b: { attemptId: Types.ObjectId; sessionId: Types.ObjectId; userId: Types.ObjectId };
  language: CodingLanguageT;
  /** Jaccard similarity of the winnowed fingerprints (0–1). */
  similarity: number;
  /** Share of the smaller submission's fingerprints found in the other (0–1). */
  containment: number;
  threshold: number;
  algorithmVersion: number;
  computedAt: Date;
}

const pairSide = new Schema(
  {
    attemptId: { type: Schema.Types.ObjectId, required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false },
);

const codeSimilarityFlagSchema = new Schema<CodeSimilarityFlagRecord>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    problemKey: { type: String, required: true },
    problemTitle: { type: String, required: true },
    a: { type: pairSide, required: true },
    b: { type: pairSide, required: true },
    language: { type: String, enum: CodingLanguage.options, required: true },
    similarity: { type: Number, required: true },
    containment: { type: Number, required: true },
    threshold: { type: Number, required: true },
    algorithmVersion: { type: Number, required: true },
    computedAt: { type: Date, required: true },
  },
  { collection: 'codeSimilarityFlags' },
);
codeSimilarityFlagSchema.index({ 'a.attemptId': 1, 'b.attemptId': 1 }, { unique: true });
codeSimilarityFlagSchema.index({ 'a.sessionId': 1 });
codeSimilarityFlagSchema.index({ 'b.sessionId': 1 });
codeSimilarityFlagSchema.index({ campaignId: 1, similarity: -1 });

export const CodeSimilarityFlagModel = model<CodeSimilarityFlagRecord>(
  'CodeSimilarityFlag',
  codeSimilarityFlagSchema,
);
