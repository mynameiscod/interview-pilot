import {
  FeedbackModel,
  InterviewReportModel,
  InterviewSessionModel,
  type InterviewReportRecord,
} from '@cbi/db';
import type { StorageProvider } from '@cbi/provider-adapters';
import { compareAttempts } from '@cbi/scoring-core';
import type {
  CompareResult,
  FeedbackBody,
  FeedbackSummary,
  ProcessingProgress,
  ReportHistoryItem,
  ReportSummary,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { JobQueues } from '../../lib/jobs.js';
import type { ClientContext } from '../../lib/request-context.js';

interface Deps {
  storage: StorageProvider;
  jobs: JobQueues;
  audit: AuditService;
}

/** The latest candidate-visible revision of each of the user's reports (or of one session). */
async function latestReports(userId: string, sessionIds?: string[]) {
  const rows = await InterviewReportModel.find({
    userId,
    'visibility.candidate': true,
    ...(sessionIds ? { sessionId: { $in: sessionIds.map((id) => objectId(id, 'Report')) } } : {}),
  })
    .sort({ revision: -1 })
    .lean();
  const bySession = new Map<string, InterviewReportRecord>();
  for (const r of rows)
    if (!bySession.has(String(r.sessionId))) bySession.set(String(r.sessionId), r);
  return [...bySession.values()];
}

export function createReportsService({ storage, jobs, audit }: Deps) {
  async function one(userId: string, sessionId: string) {
    const [report] = await latestReports(userId, [sessionId]);
    if (!report) throw AppError.notFound('Report not found');
    return report;
  }

  return {
    async get(userId: string, sessionId: string): Promise<ReportSummary> {
      const report = await one(userId, sessionId);
      const session = await InterviewSessionModel.findById(report.sessionId, { credit: 1 }).lean();
      return {
        sessionId: String(report.sessionId),
        revision: report.revision,
        generatedAt: iso(report.generatedAt),
        content: report.content,
        pdfReady: report.pdf.status === 'READY',
        credit: session?.credit?.status ?? 'NONE',
      };
    },

    async pdf(userId: string, sessionId: string) {
      const report = await one(userId, sessionId);
      if (report.pdf.status !== 'READY' || !report.pdf.storageKey) {
        throw new AppError(
          409,
          'INVALID_STATE',
          'The PDF is still being prepared. Try again shortly.',
        );
      }
      return {
        body: await storage.get(report.pdf.storageKey),
        fileName: `readiness-report-${String(report.sessionId)}.pdf`,
      };
    },

    async history(userId: string): Promise<ReportHistoryItem[]> {
      const reports = (await latestReports(userId)).sort(
        (a, b) => b.generatedAt.getTime() - a.generatedAt.getTime(),
      );
      return reports.map((r) => ({
        sessionId: String(r.sessionId),
        title: r.content.header.title,
        companyName: r.content.header.companyName,
        roleKey: r.roleKey,
        mode: r.content.header.mode,
        language: r.content.header.language,
        overall: r.content.overall.score,
        band: r.content.overall.band,
        confidence: r.content.overall.confidence.level,
        durationSec: r.content.header.durationSec,
        endedAt: r.content.header.endedAt,
      }));
    },

    /** 2–4 attempts at the same role, oldest first (design screen 26). */
    async compare(userId: string, sessionIds: string[]): Promise<CompareResult> {
      const unique = [...new Set(sessionIds)];
      if (unique.length < 2) throw AppError.validation('Choose at least two different attempts.');
      const reports = await latestReports(userId, unique);
      if (reports.length !== unique.length) throw AppError.notFound('Report not found');
      if (new Set(reports.map((r) => r.roleKey ?? String(r.sessionId))).size !== 1) {
        throw AppError.validation('Compare attempts at the same role.');
      }
      const ordered = reports.sort(
        (a, b) =>
          new Date(a.content.header.endedAt ?? a.generatedAt).getTime() -
          new Date(b.content.header.endedAt ?? b.generatedAt).getTime(),
      );
      return {
        attempts: ordered.map((r) => ({
          sessionId: String(r.sessionId),
          endedAt: r.content.header.endedAt,
          overall: r.content.overall.score,
          confidence: r.content.overall.confidence.level,
        })),
        dimensions: compareAttempts(
          ordered.map((r) => ({
            dimensions: r.content.dimensions.map((d) => ({
              key: d.key,
              name: d.name,
              score: d.score,
            })),
          })),
        ),
      };
    },

    async progress(userId: string, sessionId: string): Promise<ProcessingProgress> {
      const s = await InterviewSessionModel.findOne(
        { _id: objectId(sessionId, 'Interview'), userId },
        { state: 1, processing: 1 },
      ).lean();
      if (!s) throw AppError.notFound('Interview not found');
      return {
        stage: s.processing?.stage ?? null,
        status: s.processing?.status ?? null,
        completedStages: s.processing?.completed ?? [],
        reportReady: s.state === 'REPORT_READY',
      };
    },

    async saveFeedback(
      userId: string,
      body: FeedbackBody,
      ctx: ClientContext,
    ): Promise<FeedbackSummary> {
      const session = await InterviewSessionModel.findOne(
        { _id: objectId(body.sessionId, 'Interview'), userId },
        { state: 1 },
      ).lean();
      if (!session) throw AppError.notFound('Interview not found');
      if (!['PROCESSING', 'REPORT_READY', 'EXPIRED'].includes(session.state)) {
        throw new AppError(409, 'INVALID_STATE', 'Feedback opens once the interview has finished.');
      }
      // One feedback per interview; sending again updates it.
      const saved = await FeedbackModel.findOneAndUpdate(
        { sessionId: session._id, userId },
        {
          $set: {
            ratings: body.ratings,
            freeText: body.freeText,
            intendsRetake: body.intendsRetake,
          },
        },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      await audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'feedback.submitted',
          resourceType: 'interviewSession',
          resourceId: body.sessionId,
          details: { accuracy: body.ratings.accuracy },
        },
        ctx,
      );
      return {
        sessionId: body.sessionId,
        ratings: saved!.ratings,
        freeText: saved!.freeText,
        intendsRetake: saved!.intendsRetake,
        createdAt: iso(saved!.createdAt),
      };
    },

    async getFeedback(userId: string, sessionId: string): Promise<FeedbackSummary | null> {
      const f = await FeedbackModel.findOne({
        sessionId: objectId(sessionId, 'Interview'),
        userId,
      }).lean();
      return f
        ? {
            sessionId,
            ratings: f.ratings,
            freeText: f.freeText,
            intendsRetake: f.intendsRetake,
            createdAt: iso(f.createdAt),
          }
        : null;
    },

    /** Admin: start a new evaluation run for a session stuck or failed in PROCESSING. */
    async reprocess(sessionId: string, actorId: string, reason: string, ctx: ClientContext) {
      const id = objectId(sessionId, 'Interview');
      const session = await InterviewSessionModel.findById(id, { state: 1, processing: 1 }).lean();
      if (!session) throw AppError.notFound('Interview not found');
      if (session.state !== 'PROCESSING') {
        throw new AppError(
          409,
          'INVALID_STATE',
          'Only interviews waiting in PROCESSING can be re-run.',
        );
      }
      const run = await jobs.evaluateInterview(sessionId, { rerun: true });
      if (run === null) throw AppError.conflict('The interview changed. Refresh and try again.');
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'interview.evaluation_rerun',
          resourceType: 'interviewSession',
          resourceId: sessionId,
          details: {
            run,
            previousStage: session.processing?.stage ?? null,
            previousStatus: session.processing?.status ?? null,
            reason,
          },
        },
        ctx,
      );
      return { run };
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
