import type { Redis } from '@cbi/db';
import {
  AnalysisJob,
  DocumentJob,
  jobId,
  QueueName,
  type InterviewAnalyzeJobData,
  type JdExtractJobData,
  type ResumeExtractJobData,
} from '@cbi/shared-types';
import { Queue, type JobsOptions } from 'bullmq';

/** Background work the API hands to the worker. Ids only; the worker reloads state. */
export interface JobQueues {
  extractResume(resumeId: string): Promise<void>;
  extractJobTarget(jobTargetId: string): Promise<void>;
  /** `attempt` (the session's stateVersion) makes each re-analysis a distinct job. */
  analyzeInterview(sessionId: string, attempt: number): Promise<void>;
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
    async close() {
      await Promise.all([documents.close(), analysis.close()]);
    },
  };
}
