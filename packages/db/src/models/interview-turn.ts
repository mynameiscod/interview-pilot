import { Difficulty, QuestionSource, RoundType, TurnSufficiency } from '@cbi/shared-types';
import type {
  Difficulty as DifficultyT,
  QuestionSource as QuestionSourceT,
  RoundType as RoundTypeT,
  TurnSufficiency as TurnSufficiencyT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * One question and its answer: the question ledger (design §29). The
 * assessment (`turnEval`) is internal and never sent to the candidate live.
 */
export interface InterviewTurnRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  seq: number;
  /** Public id of the question (sent to the client). */
  questionId: string;
  roundIdx: number;
  roundType: RoundTypeT;
  question: {
    text: string;
    competencyKey: string | null;
    competencyName: string | null;
    source: QuestionSourceT;
    difficulty: DifficultyT;
    objective: string;
    expectedEvidence: string[];
    followUpOf: string | null;
    followUpDepth: number;
    probeTopic: string | null;
    promptVersion: number | null;
    model: string | null;
  };
  askedAt: Date;
  answer: {
    text: string;
    clientMsgId: string;
    answeredAt: Date;
    /** Time from the question being shown to the answer arriving. */
    durationMs: number;
  } | null;
  turnEval: {
    sufficiency: TurnSufficiencyT;
    followUpNeeded: boolean;
    followUpAngle: string | null;
    evidence: string[];
    notes: string | null;
    promptVersion: number | null;
    model: string | null;
    /** The assessment could not run; the planner treated the answer as adequate. */
    fallback: boolean;
  } | null;
  language: string;
  createdAt: Date;
  updatedAt: Date;
}

const turnSchema = new Schema<InterviewTurnRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    seq: { type: Number, required: true },
    questionId: { type: String, required: true },
    roundIdx: { type: Number, required: true },
    roundType: { type: String, enum: RoundType.options, required: true },
    question: {
      type: new Schema(
        {
          text: { type: String, required: true },
          competencyKey: { type: String, default: null },
          competencyName: { type: String, default: null },
          source: { type: String, enum: QuestionSource.options, required: true },
          difficulty: { type: String, enum: Difficulty.options, required: true },
          objective: { type: String, required: true },
          expectedEvidence: { type: [String], default: [] },
          followUpOf: { type: String, default: null },
          followUpDepth: { type: Number, default: 0 },
          probeTopic: { type: String, default: null },
          promptVersion: { type: Number, default: null },
          model: { type: String, default: null },
        },
        { _id: false },
      ),
      required: true,
    },
    askedAt: { type: Date, required: true },
    answer: {
      type: new Schema(
        {
          text: { type: String, required: true },
          clientMsgId: { type: String, required: true },
          answeredAt: { type: Date, required: true },
          durationMs: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    turnEval: {
      type: new Schema(
        {
          sufficiency: { type: String, enum: TurnSufficiency.options, required: true },
          followUpNeeded: { type: Boolean, required: true },
          followUpAngle: { type: String, default: null },
          evidence: { type: [String], default: [] },
          notes: { type: String, default: null },
          promptVersion: { type: Number, default: null },
          model: { type: String, default: null },
          fallback: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: null,
    },
    language: { type: String, required: true, default: 'en' },
  },
  { timestamps: true, collection: 'interviewTurns' },
);
turnSchema.index({ sessionId: 1, seq: 1 }, { unique: true });
turnSchema.index({ questionId: 1 }, { unique: true });
turnSchema.index({ sessionId: 1, roundIdx: 1 });
turnSchema.index(
  { sessionId: 1, 'answer.clientMsgId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'answer.clientMsgId': { $type: 'string' } },
    name: 'one_answer_per_client_message',
  },
);

export const InterviewTurnModel: Model<InterviewTurnRecord> =
  (mongoose.models.InterviewTurn as Model<InterviewTurnRecord> | undefined) ??
  mongoose.model<InterviewTurnRecord>('InterviewTurn', turnSchema);
