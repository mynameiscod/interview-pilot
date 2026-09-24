import {
  AnalysisFailureCode,
  ConsentType,
  InterviewLanguagePreference,
  InterviewMode,
  InterviewState,
  type RoleAnalysis,
} from '@cbi/shared-types';
import type {
  ConsentType as ConsentTypeT,
  DeviceCheckBody,
  ProcessingStage,
  ProcessingStatus,
  RecommendationsAi,
  AnalysisFailureCode as AnalysisFailureCodeT,
  InterviewLanguagePreference as InterviewLanguagePreferenceT,
  InterviewMode as InterviewModeT,
  InterviewState as InterviewStateT,
} from '@cbi/shared-types';
import type { PlannerState } from '@cbi/interview-engine';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

export type CreditStatus = 'NONE' | 'RESERVED' | 'CONSUMED' | 'REFUNDED';

/** A dimension scored by the pipeline, kept until the score revision is written. */
export interface DraftDimensionScore {
  key: string;
  aiScore: number | null;
  rationale: string | null;
  evidenceIds: string[];
  promptVersion: number | null;
}

/** Evaluation pipeline progress (Phase 5). */
export interface SessionProcessingRecord {
  /** Bumped when processing is re-run; job ids include it. */
  run: number;
  stage: ProcessingStage | null;
  status: ProcessingStatus | null;
  completed: ProcessingStage[];
  attempts: number;
  error: string | null;
  updatedAt: Date | null;
  /** Intermediate results handed from one stage to the next. */
  draft: {
    dimensions?: DraftDimensionScore[];
    recommendations?: RecommendationsAi & { promptVersion: number | null; fallback: boolean };
  };
}

export interface SessionClockRecord {
  budgetMs: number;
  activeMs: number;
  runningSince: Date | null;
}

export interface InterviewSessionRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  jobTargetId: Types.ObjectId;
  resumeId: Types.ObjectId | null;
  /** Exact versions this session uses (§59); set at creation/analysis and never changed. */
  templateId: Types.ObjectId;
  blueprintId: Types.ObjectId | null;
  promptVersions: Record<string, number>;
  mode: InterviewModeT;
  language: InterviewLanguagePreferenceT;
  state: InterviewStateT;
  /** Optimistic-concurrency counter: every transition is conditional on it. */
  stateVersion: number;
  stateHistory: { from: InterviewStateT; to: InterviewStateT; at: Date; reason: string | null }[];
  analysis: RoleAnalysis | null;
  analysisAttempts: number;
  failure: { code: AnalysisFailureCodeT; at: Date } | null;

  // ---- Live interview (Phase 4) ----
  /** True while in an in-progress state; a partial unique index allows one per user. */
  live: boolean;
  clock: SessionClockRecord | null;
  planner: PlannerState | null;
  /** Where RECONNECTING/PAUSED return to. */
  resumeTo: 'ACTIVE' | 'ROUND_TRANSITION' | null;
  credit: { status: CreditStatus; lotId: Types.ObjectId | null };
  /** Highest turn seq issued. */
  lastSeq: number;
  startedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  /** Last heartbeat or message from the candidate's room. */
  lastSeenAt: Date | null;
  disconnectedAt: Date | null;
  pausedAt: Date | null;
  processing: SessionProcessingRecord | null;

  // ---- Voice (Phase 7) ----
  /** Set once the interview is configured for voice or video; null for text-only interviews. */
  voice: SessionVoiceRecord | null;
  /** The latest decision per consent type for this interview (full history in `consents`). */
  consents: SessionConsentRecord[];
  /** Video recording, decided at start from the template policy and the RECORDING consent. */
  recording: { enabled: boolean } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionConsentRecord {
  type: ConsentTypeT;
  consentTextId: Types.ObjectId;
  version: number;
  accepted: boolean;
  at: Date;
}

export interface SessionVoiceRecord {
  /** The spoken mode the interview was set up for (switching back from text returns to it). */
  spokenMode: 'VOICE' | 'VIDEO' | null;
  deviceCheck: (DeviceCheckBody & { at: Date; passed: boolean }) | null;
  /** Switches between voice and text during the interview. */
  modeHistory: { mode: 'TEXT' | 'VOICE' | 'VIDEO'; at: Date; reason: string }[];
}

const voiceSchema = new Schema<SessionVoiceRecord>(
  {
    spokenMode: { type: String, enum: ['VOICE', 'VIDEO', null], default: null },
    deviceCheck: { type: Schema.Types.Mixed, default: null },
    modeHistory: {
      type: [
        new Schema(
          {
            mode: { type: String, enum: ['TEXT', 'VOICE', 'VIDEO'], required: true },
            at: { type: Date, required: true },
            reason: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { _id: false },
);

const sessionSchema = new Schema<InterviewSessionRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    jobTargetId: { type: Schema.Types.ObjectId, ref: 'JobTarget', required: true },
    resumeId: { type: Schema.Types.ObjectId, ref: 'Resume', default: null },
    templateId: { type: Schema.Types.ObjectId, ref: 'InterviewTemplate', required: true },
    blueprintId: { type: Schema.Types.ObjectId, ref: 'RoleBlueprint', default: null },
    promptVersions: { type: Schema.Types.Mixed, default: {} },
    mode: { type: String, enum: InterviewMode.options, required: true, default: 'TEXT' },
    language: {
      type: String,
      enum: InterviewLanguagePreference.options,
      required: true,
      default: 'auto',
    },
    state: { type: String, enum: InterviewState.options, required: true, default: 'DRAFT' },
    stateVersion: { type: Number, required: true, default: 0 },
    stateHistory: {
      type: [
        new Schema(
          {
            from: { type: String, enum: InterviewState.options, required: true },
            to: { type: String, enum: InterviewState.options, required: true },
            at: { type: Date, required: true },
            reason: { type: String, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    analysis: { type: Schema.Types.Mixed, default: null },
    analysisAttempts: { type: Number, default: 0 },
    failure: {
      type: new Schema(
        {
          code: { type: String, enum: AnalysisFailureCode.options, required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    live: { type: Boolean, default: false },
    clock: {
      type: new Schema(
        {
          budgetMs: { type: Number, required: true },
          activeMs: { type: Number, required: true },
          runningSince: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    planner: { type: Schema.Types.Mixed, default: null },
    resumeTo: { type: String, enum: ['ACTIVE', 'ROUND_TRANSITION', null], default: null },
    credit: {
      type: new Schema(
        {
          status: {
            type: String,
            enum: ['NONE', 'RESERVED', 'CONSUMED', 'REFUNDED'],
            required: true,
          },
          lotId: { type: Schema.Types.ObjectId, default: null },
        },
        { _id: false },
      ),
      default: () => ({ status: 'NONE', lotId: null }),
    },
    lastSeq: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: null },
    lastSeenAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    processing: { type: Schema.Types.Mixed, default: null },
    voice: { type: voiceSchema, default: null },
    consents: {
      type: [
        new Schema(
          {
            type: { type: String, enum: ConsentType.options, required: true },
            consentTextId: { type: Schema.Types.ObjectId, ref: 'ConsentText', required: true },
            version: { type: Number, required: true },
            accepted: { type: Boolean, required: true },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    recording: {
      type: new Schema({ enabled: { type: Boolean, required: true } }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true, collection: 'interviewSessions', minimize: false },
);
sessionSchema.index({ userId: 1, createdAt: -1 });
sessionSchema.index({ state: 1, updatedAt: 1 });
sessionSchema.index({ state: 1, 'processing.status': 1, 'processing.updatedAt': 1 });
sessionSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { live: true }, name: 'one_live_interview_per_user' },
);

export const InterviewSessionModel: Model<InterviewSessionRecord> =
  (mongoose.models.InterviewSession as Model<InterviewSessionRecord> | undefined) ??
  mongoose.model<InterviewSessionRecord>('InterviewSession', sessionSchema);
