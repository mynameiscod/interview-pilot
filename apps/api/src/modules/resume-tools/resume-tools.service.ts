import { createHash } from 'node:crypto';
import type { Logger } from '@cbi/config';
import {
  JobTargetModel,
  ResumeModel,
  ResumeTailoringModel,
  type JobTargetRecord,
  type ResumeRecord,
  type ResumeTailoringRecord,
} from '@cbi/db';
import { scoreResumeMatch } from '@cbi/scoring-core';
import type {
  ResumeMatchReport,
  ResumeTailoringSummary,
  ResumeToolsBody,
} from '@cbi/shared-types';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { JobQueues } from '../../lib/jobs.js';

interface Deps {
  jobs: JobQueues;
  logger: Logger;
  /** Tailoring requests (billed AI calls) per candidate per rolling 24 hours. */
  tailorDailyLimit: number;
}

const DAY_MS = 24 * 3600 * 1000;
/** Unchanged inputs reuse suggestions this recent instead of a new AI call. */
const REUSE_MS = 7 * DAY_MS;

const notReady = () =>
  new AppError(
    409,
    'INVALID_STATE',
    'Your resume or job description is still being read, or could not be read. Try again when both are ready.',
  );

export function tailoringSummary(t: ResumeTailoringRecord): ResumeTailoringSummary {
  return {
    id: String(t._id),
    resumeId: String(t.resumeId),
    jobTargetId: String(t.jobTargetId),
    status: t.status,
    suggestions: t.suggestions,
    failureCode: t.failureCode,
    createdAt: iso(t.createdAt),
    completedAt: t.completedAt ? iso(t.completedAt) : null,
  };
}

/**
 * Identifies the exact inputs of a tailoring request: both documents, when
 * they were read and when they were last edited.
 */
export function tailoringInputKey(resume: ResumeRecord, target: JobTargetRecord): string {
  const stamp = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : '-');
  return createHash('sha256')
    .update(
      [
        String(resume._id),
        stamp(resume.extraction.completedAt),
        stamp(resume.editedAt),
        String(target._id),
        stamp(target.extraction.completedAt),
        stamp(target.editedAt),
      ].join('|'),
    )
    .digest('hex');
}

/**
 * Resume tools. The match score is deterministic and computed on request
 * (free, rate-limited); tailoring suggestions are one AI call in the worker,
 * reused while neither document changes.
 */
export function createResumeToolsService({ jobs, logger, tailorDailyLimit }: Deps) {
  /** Both inputs, the candidate's own and fully read. The JD must have text (not role only). */
  async function loadInputs(userId: string, body: ResumeToolsBody) {
    const [resume, target] = await Promise.all([
      ResumeModel.findOne({ _id: objectId(body.resumeId, 'Resume'), userId }).lean(),
      JobTargetModel.findOne({
        _id: objectId(body.jobTargetId, 'Job target'),
        userId,
        deletedAt: null,
      }).lean(),
    ]);
    if (!resume) throw AppError.notFound('Resume not found');
    if (!target) throw AppError.notFound('Job target not found');
    if (target.source === 'ROLE_ONLY') {
      throw AppError.validation('Add a job description to compare your resume against.');
    }
    if (resume.extraction.status !== 'READY' || target.extraction.status !== 'READY') {
      throw notReady();
    }
    return { resume: resume as ResumeRecord, target: target as JobTargetRecord };
  }

  return {
    async match(userId: string, body: ResumeToolsBody): Promise<ResumeMatchReport> {
      const { resume, target } = await loadInputs(userId, body);
      return scoreResumeMatch(
        {
          text: resume.rawText ?? '',
          structured: resume.edited ?? resume.structured,
          layout: resume.layout ?? null,
          edited: Boolean(resume.edited),
        },
        {
          text: target.rawText ?? '',
          structured: target.edited ?? target.structured,
          edited: Boolean(target.edited),
        },
      );
    },

    /**
     * Starts (or reuses) tailoring suggestions. Unchanged inputs within a
     * week return the earlier record instead of another billed AI call.
     */
    async requestTailoring(userId: string, body: ResumeToolsBody) {
      const { resume, target } = await loadInputs(userId, body);
      const inputKey = tailoringInputKey(resume, target);
      const recent = await ResumeTailoringModel.findOne({
        userId,
        inputKey,
        status: { $in: ['PENDING', 'READY'] },
        createdAt: { $gte: new Date(Date.now() - REUSE_MS) },
      })
        .sort({ createdAt: -1 })
        .lean();
      if (recent) return { created: false, tailoring: tailoringSummary(recent) };

      const today = await ResumeTailoringModel.countDocuments({
        userId,
        createdAt: { $gte: new Date(Date.now() - DAY_MS) },
      });
      if (today >= tailorDailyLimit) {
        throw new AppError(
          429,
          'QUOTA_EXCEEDED',
          `You can ask for tailoring suggestions up to ${tailorDailyLimit} times a day. Please try again tomorrow.`,
          { limit: tailorDailyLimit },
        );
      }
      const record = await ResumeTailoringModel.create({
        userId,
        resumeId: resume._id,
        jobTargetId: target._id,
        inputKey,
      });
      try {
        await jobs.tailorResume(String(record._id));
      } catch (err) {
        logger.error({ err, tailoringId: String(record._id) }, 'failed to enqueue tailoring');
        await ResumeTailoringModel.deleteOne({ _id: record._id });
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'We could not start this. Please try again.');
      }
      return { created: true, tailoring: tailoringSummary(record.toObject()) };
    },

    async getTailoring(userId: string, id: string) {
      const record = await ResumeTailoringModel.findOne({
        _id: objectId(id, 'Tailoring'),
        userId,
      }).lean();
      if (!record) throw AppError.notFound('Tailoring suggestions not found');
      return tailoringSummary(record);
    },
  };
}

export type ResumeToolsService = ReturnType<typeof createResumeToolsService>;
