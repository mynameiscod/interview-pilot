import { BadgeKey, ReadinessBand } from '@cbi/shared-types';
import type { BadgeKey as BadgeKeyT, ReadinessBand as ReadinessBandT } from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

// ---- planItemProgress ------------------------------------------------------------------------

/**
 * A candidate ticking a plan item done (or undone). Items are identified per
 * report revision (`next24h.0` in revision 0), so a reviewed revision starts
 * with a fresh checklist.
 */
export interface PlanItemProgressRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  revision: number;
  itemId: string;
  done: boolean;
  doneAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const planItemSchema = new Schema<PlanItemProgressRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    revision: { type: Number, required: true },
    itemId: { type: String, required: true, maxlength: 20 },
    done: { type: Boolean, required: true },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'planItemProgress' },
);
planItemSchema.index({ userId: 1, sessionId: 1, revision: 1, itemId: 1 }, { unique: true });

export const PlanItemProgressModel = model<PlanItemProgressRecord>(
  'PlanItemProgress',
  planItemSchema,
);

// ---- userProgress ------------------------------------------------------------------------------

/** Goals the candidate sets, and when they were last sent a practice nudge. */
export interface UserProgressRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** Null: the `practice.defaultWeeklyGoal` setting. */
  weeklyTarget: number | null;
  /** India-time day of the real interview the candidate is preparing for. */
  targetDate: string | null;
  /** At most one practice nudge email every NUDGE_INTERVAL (claimed atomically). */
  lastNudgeAt: Date | null;
  nudgesSent: number;
  createdAt: Date;
  updatedAt: Date;
}

const userProgressSchema = new Schema<UserProgressRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    weeklyTarget: { type: Number, min: 1, max: 14, default: null },
    targetDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    lastNudgeAt: { type: Date, default: null },
    nudgesSent: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'userProgress' },
);
userProgressSchema.index({ userId: 1 }, { unique: true });

export const UserProgressModel = model<UserProgressRecord>('UserProgress', userProgressSchema);

// ---- badgeAwards ---------------------------------------------------------------------------------

/** A badge earned. Unique per user and badge, so awarding is idempotent. */
export interface BadgeAwardRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  badge: BadgeKeyT;
  /** When the facts earned it (not when it was noticed). */
  awardedAt: Date;
  createdAt: Date;
}

const badgeSchema = new Schema<BadgeAwardRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    badge: { type: String, enum: BadgeKey.options, required: true },
    awardedAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'badgeAwards' },
);
badgeSchema.index({ userId: 1, badge: 1 }, { unique: true });

export const BadgeAwardModel = model<BadgeAwardRecord>('BadgeAward', badgeSchema);

// ---- certificates -----------------------------------------------------------------------------------

export type CertificatePdfStatus = 'PENDING' | 'READY' | 'FAILED';

/**
 * A readiness certificate for one report revision. The facts shown are
 * frozen at issue; `code` is public (it is printed on the PDF and opens the
 * verification page) and random, so codes cannot be guessed.
 */
export interface CertificateRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  reportRevision: number;
  code: string;
  candidateName: string | null;
  roleTitle: string;
  overall: number | null;
  band: ReadinessBandT;
  completedAt: Date | null;
  issuedAt: Date;
  pdf: { status: CertificatePdfStatus; storageKey: string | null; generatedAt: Date | null };
  createdAt: Date;
  updatedAt: Date;
}

const certificateSchema = new Schema<CertificateRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    reportRevision: { type: Number, required: true },
    code: { type: String, required: true },
    candidateName: { type: String, default: null },
    roleTitle: { type: String, required: true },
    overall: { type: Number, default: null },
    band: { type: String, enum: ReadinessBand.options, required: true },
    completedAt: { type: Date, default: null },
    issuedAt: { type: Date, required: true },
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
  },
  { timestamps: true, collection: 'certificates' },
);
certificateSchema.index({ code: 1 }, { unique: true });
// One certificate per interview.
certificateSchema.index({ userId: 1, sessionId: 1 }, { unique: true });

export const CertificateModel = model<CertificateRecord>('Certificate', certificateSchema);
