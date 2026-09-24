import type { ProcessingStage } from '@cbi/shared-types';
import type { Types } from 'mongoose';
import { InterviewSessionModel, type SessionProcessingRecord } from './models/interview-session.js';

export const FIRST_STAGE: ProcessingStage = 'FINALIZE_TRANSCRIPT';

const freshRun = (run: number, now: Date): SessionProcessingRecord => ({
  run,
  stage: FIRST_STAGE,
  status: 'QUEUED',
  completed: [],
  attempts: 0,
  error: null,
  updatedAt: now,
  draft: {},
});

/**
 * Starts evaluation for a PROCESSING session exactly once and returns the
 * run number to enqueue, or null when it has already started. With
 * `rerun`, a PROCESSING session (typically one whose pipeline failed) starts
 * a new run from the first stage; reports are never rebuilt this way.
 */
export async function beginEvaluation(
  sessionId: Types.ObjectId | string,
  opts: { rerun?: boolean; now?: Date } = {},
): Promise<number | null> {
  const now = opts.now ?? new Date();
  if (!opts.rerun) {
    const res = await InterviewSessionModel.updateOne(
      { _id: sessionId, state: 'PROCESSING', processing: null },
      { $set: { processing: freshRun(1, now) } },
    );
    return res.modifiedCount === 1 ? 1 : null;
  }
  const s = await InterviewSessionModel.findOne(
    { _id: sessionId, state: 'PROCESSING' },
    { processing: 1 },
  ).lean();
  if (!s) return null;
  const run = (s.processing?.run ?? 0) + 1;
  const res = await InterviewSessionModel.updateOne(
    { _id: sessionId, state: 'PROCESSING', 'processing.run': s.processing?.run ?? null },
    { $set: { processing: freshRun(run, now) } },
  );
  return res.modifiedCount === 1 ? run : null;
}
