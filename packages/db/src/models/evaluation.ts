import {
  CompetencyCategory,
  ConfidenceLevel,
  ReadinessBand,
  type ReportContent,
} from '@cbi/shared-types';
import type {
  CompetencyCategory as CompetencyCategoryT,
  ConfidenceLevel as ConfidenceLevelT,
  ReadinessBand as ReadinessBandT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

/** Revisions are immutable: only listed fields may change after insert. */
function immutable(schema: Schema, collection: string, mutable: readonly string[] = []) {
  const allowed = new Set(mutable);
  for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
    schema.pre(op, function () {
      const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
      const fields = Object.entries(update).flatMap(([k, v]) =>
        k.startsWith('$') ? Object.keys((v ?? {}) as object) : [k],
      );
      const forbidden = fields.filter(
        (f) => ![...allowed].some((a) => f === a || f.startsWith(`${a}.`)),
      );
      if (forbidden.length > 0) {
        throw new Error(
          `${collection} revisions are immutable (attempted: ${forbidden.join(', ')})`,
        );
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
    schema.pre(op, function () {
      throw new Error(`${collection} revisions cannot be replaced or deleted`);
    });
  }
}

// ---- interviewEvidence ------------------------------------------------------------------------

export interface InterviewEvidenceRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  /** Pipeline run that produced it (re-runs write a new set). */
  run: number;
  roundIdx: number;
  questionId: string;
  competencyKey: string;
  claim: string;
  strength: number;
  confidence: number;
  practical: boolean;
  quote: string | null;
  uncertainty: string | null;
  /** The extraction prompt version. */
  extractorVersion: number | null;
  createdAt: Date;
}

const evidenceSchema = new Schema<InterviewEvidenceRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    run: { type: Number, required: true },
    roundIdx: { type: Number, required: true },
    questionId: { type: String, required: true },
    competencyKey: { type: String, required: true },
    claim: { type: String, required: true },
    strength: { type: Number, required: true, min: -2, max: 2 },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    practical: { type: Boolean, required: true },
    quote: { type: String, default: null },
    uncertainty: { type: String, default: null },
    extractorVersion: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'interviewEvidence' },
);
evidenceSchema.index({ sessionId: 1, competencyKey: 1 });
evidenceSchema.index({ sessionId: 1, run: 1, roundIdx: 1 });

export const InterviewEvidenceModel = model<InterviewEvidenceRecord>(
  'InterviewEvidence',
  evidenceSchema,
);

// ---- interviewScores ---------------------------------------------------------------------------

export interface ScoreDimensionRecord {
  key: string;
  name: string;
  category: CompetencyCategoryT;
  /** Share of the overall score in percent. */
  weight: number;
  score: number | null;
  /** What the scoring model said before the evidence guard (null when unavailable). */
  aiScore: number | null;
  adjusted: boolean;
  fallback: boolean;
  rationale: string | null;
  evidenceIds: string[];
}

export interface InterviewScoreRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  /** 0 = the AI original; manual reviews add revisions (never edit). */
  revision: number;
  dimensions: ScoreDimensionRecord[];
  overall: number | null;
  band: ReadinessBandT;
  confidence: {
    level: ConfidenceLevelT;
    value: number;
    factors: {
      independentQuestions: number;
      practicalEvidence: number;
      consistency: number;
      completeness: number;
    };
  };
  assessedWeight: number;
  /** The scoring policy lives in the session's pinned template version. */
  templateId: Types.ObjectId;
  promptVersions: Record<string, number>;
  createdBy: 'AI' | Types.ObjectId;
  reason: string | null;
  createdAt: Date;
}

const scoreSchema = new Schema<InterviewScoreRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revision: { type: Number, required: true },
    dimensions: {
      type: [
        new Schema<ScoreDimensionRecord>(
          {
            key: { type: String, required: true },
            name: { type: String, required: true },
            category: { type: String, enum: CompetencyCategory.options, required: true },
            weight: { type: Number, required: true },
            score: { type: Number, default: null },
            aiScore: { type: Number, default: null },
            adjusted: { type: Boolean, default: false },
            fallback: { type: Boolean, default: false },
            rationale: { type: String, default: null },
            evidenceIds: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    overall: { type: Number, default: null },
    band: { type: String, enum: ReadinessBand.options, required: true },
    confidence: {
      type: new Schema(
        {
          level: { type: String, enum: ConfidenceLevel.options, required: true },
          value: { type: Number, required: true },
          factors: { type: Schema.Types.Mixed, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    assessedWeight: { type: Number, required: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'InterviewTemplate', required: true },
    promptVersions: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.Mixed, required: true },
    reason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'interviewScores',
    minimize: false,
  },
);
scoreSchema.index({ sessionId: 1, revision: 1 }, { unique: true });
immutable(scoreSchema, 'interviewScores');

export const InterviewScoreModel = model<InterviewScoreRecord>('InterviewScore', scoreSchema);

// ---- interviewReports ------------------------------------------------------------------------------

export type PdfStatus = 'PENDING' | 'READY' | 'FAILED';

export interface InterviewReportRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  revision: number;
  scoreRevision: number;
  content: ReportContent;
  pdf: { status: PdfStatus; storageKey: string | null; generatedAt: Date | null };
  visibility: { candidate: boolean };
  /** Role family key for history and comparison (the matched library role or the detected title). */
  roleKey: string | null;
  overall: number | null;
  generatedAt: Date;
  createdAt: Date;
}

const reportSchema = new Schema<InterviewReportRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revision: { type: Number, required: true },
    scoreRevision: { type: Number, required: true },
    content: { type: Schema.Types.Mixed, required: true },
    pdf: {
      type: new Schema(
        {
          status: { type: String, enum: ['PENDING', 'READY', 'FAILED'], required: true },
          storageKey: { type: String, default: null },
          generatedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: () => ({ status: 'PENDING', storageKey: null, generatedAt: null }),
    },
    visibility: {
      type: new Schema({ candidate: { type: Boolean, default: true } }, { _id: false }),
      default: () => ({ candidate: true }),
    },
    roleKey: { type: String, default: null },
    overall: { type: Number, default: null },
    generatedAt: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'interviewReports',
    minimize: false,
  },
);
reportSchema.index({ sessionId: 1, revision: 1 }, { unique: true });
reportSchema.index({ userId: 1, generatedAt: -1 });
reportSchema.index({ userId: 1, roleKey: 1, generatedAt: -1 });
// The PDF is produced after the report and may be regenerated; the content never changes.
immutable(reportSchema, 'interviewReports', ['pdf', 'visibility']);

export const InterviewReportModel = model<InterviewReportRecord>('InterviewReport', reportSchema);

// ---- feedback ------------------------------------------------------------------------------------------

export interface FeedbackRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  ratings: { usefulness: number; accuracy: number; interviewQuality: number };
  freeText: string | null;
  intendsRetake: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new Schema<FeedbackRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    ratings: {
      type: new Schema(
        {
          usefulness: { type: Number, min: 1, max: 5, required: true },
          accuracy: { type: Number, min: 1, max: 5, required: true },
          interviewQuality: { type: Number, min: 1, max: 5, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    freeText: { type: String, default: null, maxlength: 2000 },
    intendsRetake: { type: Boolean, default: null },
  },
  { timestamps: true, collection: 'feedback' },
);
feedbackSchema.index({ sessionId: 1, userId: 1 }, { unique: true });
feedbackSchema.index({ createdAt: -1 });

export const FeedbackModel = model<FeedbackRecord>('Feedback', feedbackSchema);
