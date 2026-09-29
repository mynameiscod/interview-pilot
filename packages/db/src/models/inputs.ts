import {
  DocumentMime,
  ExtractionErrorCode,
  ExtractionStatus,
  ExtractionWarning,
  JobTargetSource,
  ResumeFormat,
  ResumeSource,
  TailoringStatus,
  type TailoringSuggestions,
  type DocumentLayout,
  type JdStructured,
  type ResumeStructured,
} from '@cbi/shared-types';
import type {
  DocumentMime as DocumentMimeT,
  ExtractionErrorCode as ExtractionErrorCodeT,
  ExtractionStatus as ExtractionStatusT,
  ExtractionWarning as ExtractionWarningT,
  JobTargetSource as JobTargetSourceT,
  ResumeFormat as ResumeFormatT,
  ResumeSource as ResumeSourceT,
  TailoringStatus as TailoringStatusT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

// Record types are explicit: InferSchemaType on nested schemas exhausts the checker.

export interface ExtractionRecord {
  status: ExtractionStatusT;
  errorCode: ExtractionErrorCodeT | null;
  warnings: ExtractionWarningT[];
  parser: string | null;
  ocrUsed: boolean;
  charCount: number;
  attempts: number;
  completedAt: Date | null;
}

export interface ResumeRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  storageKey: string;
  originalName: string;
  mime: DocumentMimeT;
  size: number;
  sha256: string;
  /** Missing on resumes created before pasted text was accepted (= UPLOAD). */
  source?: ResumeSourceT;
  /** Missing on older resumes (= STANDARD). */
  format?: ResumeFormatT;
  /** Extracted text, capped at DOCUMENT_LIMITS.maxTextChars. Never returned by list endpoints. */
  rawText: string | null;
  /** Layout signals from extraction (ATS formatting checks); null until extracted. */
  layout?: DocumentLayout | null;
  structured: ResumeStructured | null;
  /** The candidate's corrected revision; preferred over `structured` everywhere. */
  edited?: ResumeStructured | null;
  editedAt?: Date | null;
  extraction: ExtractionRecord;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobTargetRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  source: JobTargetSourceT;
  url: string | null;
  finalUrl: string | null;
  storageKey: string | null;
  originalName: string | null;
  mime: DocumentMimeT | null;
  sha256: string | null;
  rawText: string | null;
  structured: JdStructured | null;
  /** The candidate's corrected revision; preferred over `structured` everywhere. */
  edited?: JdStructured | null;
  editedAt?: Date | null;
  extraction: ExtractionRecord;
  companyId: Types.ObjectId | null;
  companyName: string | null;
  roleId: Types.ObjectId | null;
  roleTitle: string | null;
  /**
   * Set when the candidate deletes a job description that interviews still
   * refer to: the file and text are removed and it disappears from their
   * list; the title and company stay for those interviews' history.
   */
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const extractionSchema = new Schema<ExtractionRecord>(
  {
    status: { type: String, enum: ExtractionStatus.options, required: true, default: 'PENDING' },
    errorCode: { type: String, enum: [...ExtractionErrorCode.options, null], default: null },
    warnings: { type: [String], enum: ExtractionWarning.options, default: [] },
    parser: { type: String, default: null },
    ocrUsed: { type: Boolean, default: false },
    charCount: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

const resumeSchema = new Schema<ResumeRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    storageKey: { type: String, required: true },
    originalName: { type: String, required: true, maxlength: 200 },
    mime: { type: String, enum: DocumentMime.options, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    source: { type: String, enum: ResumeSource.options, default: 'UPLOAD' },
    format: { type: String, enum: ResumeFormat.options, default: 'STANDARD' },
    rawText: { type: String, default: null },
    layout: { type: Schema.Types.Mixed, default: null },
    structured: { type: Schema.Types.Mixed, default: null },
    edited: { type: Schema.Types.Mixed, default: null },
    editedAt: { type: Date, default: null },
    extraction: { type: extractionSchema, required: true, default: () => ({}) },
  },
  { timestamps: true, collection: 'resumes' },
);
resumeSchema.index({ userId: 1, createdAt: -1 });
resumeSchema.index({ userId: 1, sha256: 1 });

export const ResumeModel = model<ResumeRecord>('Resume', resumeSchema);

const jobTargetSchema = new Schema<JobTargetRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: String, enum: JobTargetSource.options, required: true },
    url: { type: String, default: null },
    finalUrl: { type: String, default: null },
    storageKey: { type: String, default: null },
    originalName: { type: String, default: null, maxlength: 200 },
    mime: { type: String, enum: [...DocumentMime.options, null], default: null },
    sha256: { type: String, default: null },
    rawText: { type: String, default: null },
    structured: { type: Schema.Types.Mixed, default: null },
    edited: { type: Schema.Types.Mixed, default: null },
    editedAt: { type: Date, default: null },
    extraction: { type: extractionSchema, required: true, default: () => ({}) },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null },
    companyName: { type: String, default: null },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', default: null },
    roleTitle: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'jobTargets' },
);
jobTargetSchema.index({ userId: 1, createdAt: -1 });

export const JobTargetModel = model<JobTargetRecord>('JobTarget', jobTargetSchema);

// ---- Resume tailoring suggestions ------------------------------------------------------

export interface ResumeTailoringRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  resumeId: Types.ObjectId;
  jobTargetId: Types.ObjectId;
  /**
   * Identifies the exact inputs (both documents and their edited revisions):
   * asking again for unchanged inputs returns this record instead of a new AI call.
   */
  inputKey: string;
  status: TailoringStatusT;
  suggestions: TailoringSuggestions | null;
  failureCode: 'INPUT_NOT_READY' | 'INTERNAL' | null;
  promptVersion: number | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const tailoringSchema = new Schema<ResumeTailoringRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    resumeId: { type: Schema.Types.ObjectId, ref: 'Resume', required: true },
    jobTargetId: { type: Schema.Types.ObjectId, ref: 'JobTarget', required: true },
    inputKey: { type: String, required: true },
    status: { type: String, enum: TailoringStatus.options, required: true, default: 'PENDING' },
    suggestions: { type: Schema.Types.Mixed, default: null },
    failureCode: { type: String, enum: ['INPUT_NOT_READY', 'INTERNAL', null], default: null },
    promptVersion: { type: Number, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'resumeTailorings' },
);
tailoringSchema.index({ userId: 1, inputKey: 1, createdAt: -1 });
tailoringSchema.index({ userId: 1, createdAt: -1 });
// Suggestions are cheap to regenerate and hold resume content: kept for 30 days.
tailoringSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const ResumeTailoringModel = model<ResumeTailoringRecord>(
  'ResumeTailoring',
  tailoringSchema,
);
