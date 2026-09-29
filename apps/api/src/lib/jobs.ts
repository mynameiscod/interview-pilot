import { beginEvaluation, FIRST_STAGE, type Redis } from '@cbi/db';
import {
  AnalysisJob,
  campaignPackageJobId,
  certificatePdfJobId,
  DocumentJob,
  EvaluationJob,
  evaluationJobId,
  ExportJob,
  jobId,
  QueueName,
  type CampaignPackageJobData,
  type CertificatePdfJobData,
  type EvaluationStageJobData,
  type InterviewAnalyzeJobData,
  type JdExtractJobData,
  type ReportPdfJobData,
  type ResumeExtractJobData,
} from '@cbi/shared-types';
import { Queue, type JobsOptions } from 'bullmq';

/** Background work the API hands to the worker. Ids only; the worker reloads state. */
export interface JobQueues {
  extractResume(resumeId: string): Promise<void>;
  extractJobTarget(jobTargetId: string): Promise<void>;
  /** `attempt` (the session's stateVersion) makes each re-analysis a distinct job. */
  analyzeInterview(sessionId: string, attempt: number): Promise<void>;
  /**
   * Starts the evaluation pipeline for a PROCESSING session (once), or a new
   * run with `rerun`. Returns the run number, or null when nothing started.
   */
  evaluateInterview(sessionId: string, opts?: { rerun?: boolean }): Promise<number | null>;
  /** Renders the PDF of a report revision created by a manual review. */
  renderReportPdf(sessionId: string, revision: number): Promise<void>;
  /** Renders a readiness certificate's PDF (once per certificate). */
  renderCertificatePdf(certificateId: string): Promise<void>;
  /** Builds a campaign package ZIP for a campaignExports record. */
  exportCampaignPackage(exportId: string): Promise<void>;
  close(): Promise<void>;
}

const DEFAULTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
};

export function createBullJobQueues(connection: Redis): JobQueues {
  const documents = new Queue(QueueName.DOCUMENTS, { connection, defaultJobOptions: DEFAULTS });
  const analysis = new Queue(QueueName.ANALYSIS, { connection, defaultJobOptions: DEFAULTS });
  const evaluation = new Queue(QueueName.EVALUATION, {
    connection,
    defaultJobOptions: { ...DEFAULTS, backoff: { type: 'exponential', delay: 10_000 } },
  });
  // A failed package build is retried once: it restarts from scratch and can be requested again.
  const exportsQueue = new Queue(QueueName.EXPORTS, {
    connection,
    defaultJobOptions: { ...DEFAULTS, attempts: 2, backoff: { type: 'fixed', delay: 30_000 } },
  });
  return {
    async extractResume(resumeId) {
      const data: ResumeExtractJobData = { resumeId };
      await documents.add(DocumentJob.RESUME_EXTRACT, data, {
        jobId: jobId(DocumentJob.RESUME_EXTRACT, resumeId),
      });
    },
    async extractJobTarget(jobTargetId) {
      const data: JdExtractJobData = { jobTargetId };
      await documents.add(DocumentJob.JD_EXTRACT, data, {
        jobId: jobId(DocumentJob.JD_EXTRACT, jobTargetId),
      });
    },
    async analyzeInterview(sessionId, attempt) {
      const data: InterviewAnalyzeJobData = { sessionId };
      await analysis.add(AnalysisJob.INTERVIEW_ANALYZE, data, {
        jobId: jobId(AnalysisJob.INTERVIEW_ANALYZE, sessionId, attempt),
      });
    },
    async evaluateInterview(sessionId, opts = {}) {
      const run = await beginEvaluation(sessionId, { rerun: opts.rerun });
      if (run === null) return null;
      const data: EvaluationStageJobData = { sessionId, stage: FIRST_STAGE, run };
      await evaluation.add(EvaluationJob.STAGE, data, {
        jobId: evaluationJobId(sessionId, FIRST_STAGE, run),
      });
      return run;
    },
    async renderReportPdf(sessionId, revision) {
      const data: ReportPdfJobData = { sessionId, revision };
      await evaluation.add(EvaluationJob.REPORT_PDF, data, {
        jobId: `report-pdf-${sessionId}-${revision}`,
      });
    },
    async renderCertificatePdf(certificateId) {
      const data: CertificatePdfJobData = { certificateId };
      await evaluation.add(EvaluationJob.CERTIFICATE_PDF, data, {
        jobId: certificatePdfJobId(certificateId),
      });
    },
    async exportCampaignPackage(exportId) {
      const data: CampaignPackageJobData = { exportId };
      await exportsQueue.add(ExportJob.CAMPAIGN_PACKAGE, data, {
        jobId: campaignPackageJobId(exportId),
      });
    },
    async close() {
      await Promise.all([
        documents.close(),
        analysis.close(),
        evaluation.close(),
        exportsQueue.close(),
      ]);
    },
  };
}
