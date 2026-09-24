/**
 * BullMQ queue names. Queues are separated by workload so each can have its
 * own concurrency and retry policy (see docs/architecture §2). Queues are
 * added here as the phase that needs them is implemented.
 */
export const QueueName = {
  /** Platform housekeeping: worker heartbeats, provider health, cleanup schedulers. */
  SYSTEM: 'system',
  /** Untrusted file parsing and JD URL fetching (resource-limited, Phase 3). */
  DOCUMENTS: 'documents',
  /** Role analysis and blueprint generation (AI calls, Phase 3). */
  ANALYSIS: 'analysis',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/** Redis key prefix for worker heartbeats; value is JSON, key expires if the worker dies. */
export const WORKER_HEARTBEAT_KEY_PREFIX = 'cbi:worker:heartbeat:' as const;

/** Jobs on the DOCUMENTS queue. Payloads carry ids only; workers reload state. */
export const DocumentJob = {
  RESUME_EXTRACT: 'resume.extract',
  JD_EXTRACT: 'jd.extract',
} as const;
export type DocumentJob = (typeof DocumentJob)[keyof typeof DocumentJob];

/** Jobs on the ANALYSIS queue. */
export const AnalysisJob = {
  INTERVIEW_ANALYZE: 'interview.analyze',
} as const;
export type AnalysisJob = (typeof AnalysisJob)[keyof typeof AnalysisJob];

export interface ResumeExtractJobData {
  resumeId: string;
}
export interface JdExtractJobData {
  jobTargetId: string;
}
export interface InterviewAnalyzeJobData {
  sessionId: string;
}

/**
 * Deterministic job ids make enqueueing idempotent: a second request for the
 * same work while the first is queued is a no-op. (BullMQ ids may not contain ':'.)
 */
export const jobId = (name: DocumentJob | AnalysisJob, id: string, attempt = 0) =>
  `${name.replace('.', '-')}-${id}-${attempt}`;
