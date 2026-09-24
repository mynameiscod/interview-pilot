import type { Logger } from '@cbi/config';
import {
  InterviewSessionModel,
  InterviewTemplateModel,
  JobTargetModel,
  ResumeModel,
  RoleModel,
  transitionSession,
  UserProfileModel,
  type InterviewSessionRecord,
  type InterviewTemplateRecord,
  type JobTargetRecord,
} from '@cbi/db';
import {
  AVAILABLE_INTERVIEW_MODES,
  templateDurationSec,
  type CreateInterviewBody,
  type InterviewState,
  type InterviewSummary,
  type UpdateInterviewSetupBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { JobQueues } from '../../lib/jobs.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { ConsentService } from '../consent/consent.service.js';

export const DEFAULT_TEMPLATE_KEY = 'standard-practice';
/** Analysis runs billed AI calls; repeated retries of one draft are capped. */
export const MAX_ANALYSIS_ATTEMPTS = 5;
/** Unfinished drafts per candidate (DRAFT, ROLE_ANALYSIS, READY or FAILED). */
export const MAX_OPEN_INTERVIEWS = 10;

const OPEN_STATES: InterviewState[] = ['DRAFT', 'ROLE_ANALYSIS', 'READY', 'FAILED'];
const ANALYZABLE: InterviewState[] = ['DRAFT', 'FAILED', 'READY'];
const CANCELLABLE: InterviewState[] = ['DRAFT', 'READY', 'READY_TO_START', 'FAILED'];

function interviewTitle(
  session: InterviewSessionRecord,
  target: JobTargetRecord | null,
  roleTitle?: string,
) {
  return (
    session.analysis?.detectedRole.title ??
    target?.roleTitle ??
    target?.structured?.title ??
    roleTitle ??
    'Practice interview'
  );
}

interface Deps {
  jobs: JobQueues;
  audit: AuditService;
  logger: Logger;
  consent: ConsentService;
}

export function createInterviewService({ jobs, audit, logger, consent }: Deps) {
  async function summary(
    session: InterviewSessionRecord,
    loaded?: { template?: InterviewTemplateRecord | null; target?: JobTargetRecord | null },
  ): Promise<InterviewSummary> {
    const [template, target] = await Promise.all([
      loaded?.template !== undefined
        ? loaded.template
        : InterviewTemplateModel.findById(session.templateId).lean(),
      loaded?.target !== undefined
        ? loaded.target
        : JobTargetModel.findById(session.jobTargetId, { rawText: 0 }).lean(),
    ]);
    if (!template) throw new Error(`template ${String(session.templateId)} missing`);
    const readiness = await consent.readiness(session);
    const role = target?.roleId
      ? await RoleModel.findById(target.roleId, { title: 1 }).lean()
      : null;
    return {
      id: String(session._id),
      state: session.state,
      mode: session.mode,
      language: session.language,
      jobTargetId: String(session.jobTargetId),
      resumeId: session.resumeId ? String(session.resumeId) : null,
      title: interviewTitle(session, target as JobTargetRecord | null, role?.title),
      companyName: target?.companyName ?? target?.structured?.companyName ?? null,
      template: {
        id: String(template._id),
        name: template.content.name,
        creditCost: template.content.creditCost,
        modes: template.content.modes,
        totalDurationSec: templateDurationSec(template.content),
      },
      analysis: session.analysis,
      failure: session.failure ? { code: session.failure.code, at: iso(session.failure.at) } : null,
      startedAt: session.startedAt ? iso(session.startedAt) : null,
      endedAt: session.endedAt ? iso(session.endedAt) : null,
      credit: session.credit?.status ?? 'NONE',
      voice: readiness.voice,
      consentsPending: readiness.consentsPending,
      createdAt: iso(session.createdAt),
      updatedAt: iso(session.updatedAt),
    };
  }

  async function load(userId: string, id: string) {
    const session = await InterviewSessionModel.findOne({
      _id: objectId(id, 'Interview'),
      userId,
    }).lean();
    if (!session) throw AppError.notFound('Interview not found');
    return session;
  }

  const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);

  return {
    async create(userId: string, body: CreateInterviewBody, ctx: ClientContext) {
      const target = await JobTargetModel.findOne(
        { _id: objectId(body.jobTargetId, 'Job target'), userId },
        { rawText: 0 },
      ).lean();
      // Another user's ids read exactly like missing ones (no enumeration).
      if (!target) throw AppError.notFound('Job target not found');
      if (target.extraction.status === 'FAILED') {
        throw invalidState(
          'We could not read this job description. Add it again or choose a role.',
        );
      }
      if (body.resumeId) {
        const resume = await ResumeModel.findOne(
          { _id: objectId(body.resumeId, 'Resume'), userId },
          { extraction: 1 },
        ).lean();
        if (!resume) throw AppError.notFound('Resume not found');
        if (resume.extraction.status === 'FAILED') {
          throw invalidState(
            'We could not read this resume. Upload a different file or continue without one.',
          );
        }
      }
      const template = await InterviewTemplateModel.findOne({
        key: body.templateKey ?? DEFAULT_TEMPLATE_KEY,
        status: 'ACTIVE',
      }).lean();
      if (!template) throw AppError.notFound('Interview type not found');
      if (
        (await InterviewSessionModel.countDocuments({ userId, state: { $in: OPEN_STATES } })) >=
        MAX_OPEN_INTERVIEWS
      ) {
        throw AppError.conflict(
          'You have too many unfinished interviews. Cancel one to start another.',
        );
      }
      const profile = await UserProfileModel.findOne(
        { userId },
        { preferredInterviewLanguage: 1 },
      ).lean();
      const [mode] = template.content.modes.filter((m) => AVAILABLE_INTERVIEW_MODES.includes(m));
      const session = await InterviewSessionModel.create({
        userId,
        jobTargetId: target._id,
        resumeId: body.resumeId ? objectId(body.resumeId, 'Resume') : null,
        templateId: template._id,
        mode: mode ?? 'TEXT',
        language: profile?.preferredInterviewLanguage ?? 'auto',
        state: 'DRAFT',
      });
      await audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'interview.created',
          resourceType: 'interviewSession',
          resourceId: String(session._id),
          details: { templateKey: template.key, templateVersion: template.version },
        },
        ctx,
      );
      return summary(session.toObject(), { template, target: target as JobTargetRecord });
    },

    async list(userId: string, limit: number) {
      const rows = await InterviewSessionModel.find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return Promise.all(rows.map((s) => summary(s)));
    },

    async get(userId: string, id: string) {
      return summary(await load(userId, id));
    },

    /** The raw session (owner only), for the live room. */
    record(userId: string, id: string) {
      return load(userId, id);
    },

    /** DRAFT / FAILED / READY → ROLE_ANALYSIS, then hands the work to the worker. */
    async analyze(userId: string, id: string, ctx: ClientContext) {
      const session = await load(userId, id);
      if (session.state === 'ROLE_ANALYSIS') return summary(session);
      if (!ANALYZABLE.includes(session.state)) {
        throw invalidState('This interview can no longer be analysed.');
      }
      if (session.analysisAttempts >= MAX_ANALYSIS_ATTEMPTS) {
        throw invalidState('This interview has been analysed too many times. Start a new one.');
      }
      const updated = await transitionSession({
        sessionId: session._id,
        userId,
        from: session.state,
        to: 'ROLE_ANALYSIS',
        expectedVersion: session.stateVersion,
        set: { failure: null, analysisAttempts: session.analysisAttempts + 1 },
        reason: session.state === 'DRAFT' ? 'analysis requested' : 'analysis re-requested',
      });
      // A concurrent request won the transition: report the current state.
      if (!updated) return summary(await load(userId, id));
      try {
        await jobs.analyzeInterview(String(session._id), updated.stateVersion);
      } catch (err) {
        logger.error({ err, sessionId: id }, 'failed to enqueue analysis');
        await transitionSession({
          sessionId: session._id,
          from: 'ROLE_ANALYSIS',
          to: 'FAILED',
          expectedVersion: updated.stateVersion,
          set: { failure: { code: 'INTERNAL', at: new Date() } },
          reason: 'enqueue failed',
        });
        throw new AppError(
          503,
          'SERVICE_UNAVAILABLE',
          'We could not start the analysis. Please try again.',
        );
      }
      await audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'interview.analysis_requested',
          resourceType: 'interviewSession',
          resourceId: id,
          details: { attempt: session.analysisAttempts + 1 },
        },
        ctx,
      );
      return summary(updated);
    },

    /** Mode and language, chosen after analysis (screens 11–12). */
    async updateSetup(userId: string, id: string, body: UpdateInterviewSetupBody) {
      const session = await load(userId, id);
      if (session.state !== 'READY')
        throw invalidState('Setup can be changed once analysis is ready.');
      const template = await InterviewTemplateModel.findById(session.templateId).lean();
      if (
        !template!.content.modes.includes(body.mode) ||
        !AVAILABLE_INTERVIEW_MODES.includes(body.mode)
      ) {
        throw AppError.validation('That interview mode is not available for this interview.');
      }
      const updated = await InterviewSessionModel.findOneAndUpdate(
        { _id: session._id, userId, state: 'READY', stateVersion: session.stateVersion },
        { $set: { mode: body.mode, language: body.language } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) throw AppError.conflict('This interview changed. Refresh and try again.');
      return summary(updated, { template });
    },

    async cancel(userId: string, id: string, ctx: ClientContext) {
      const session = await load(userId, id);
      if (session.state === 'CANCELLED') return summary(session);
      if (!CANCELLABLE.includes(session.state))
        throw invalidState('This interview cannot be cancelled now.');
      const updated = await transitionSession({
        sessionId: session._id,
        userId,
        from: session.state,
        to: 'CANCELLED',
        expectedVersion: session.stateVersion,
        reason: 'cancelled by candidate',
      });
      if (!updated) throw AppError.conflict('This interview changed. Refresh and try again.');
      await audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'interview.cancelled',
          resourceType: 'interviewSession',
          resourceId: id,
        },
        ctx,
      );
      return summary(updated);
    },
  };
}

export type InterviewService = ReturnType<typeof createInterviewService>;
