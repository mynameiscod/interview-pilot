import type { Logger } from '@cbi/config';
import {
  CodeSimilarityFlagModel,
  CodingAttemptModel,
  InterviewSessionModel,
  ProblemModel,
  type CodingAttemptRecord,
  type ProblemRecord,
} from '@cbi/db';
import { compareSubmissions, SIMILARITY_ALGORITHM_VERSION } from '../integrity/code-similarity.js';

/**
 * After a campaign interview is evaluated, its coding submissions are
 * compared with every other submission to the same problem (any version of
 * it) in the same campaign and language. Pairs at or above the threshold are
 * recorded as integrity observations for reviewers; nothing is scored.
 * Idempotent: a pair is stored once and refreshed on a re-run.
 */
export async function processCodeSimilarity(opts: {
  sessionId: string;
  threshold: number;
  logger: Logger;
  now?: Date;
}): Promise<{ compared: number; flagged: number }> {
  const result = { compared: 0, flagged: 0 };
  const s = await InterviewSessionModel.findById(opts.sessionId, {
    campaignId: 1,
    userId: 1,
  }).lean();
  if (!s?.campaignId) return result;
  const mine = await CodingAttemptModel.find({
    sessionId: s._id,
    submission: { $ne: null },
  }).lean<CodingAttemptRecord[]>();
  if (mine.length === 0) return result;

  const others = await InterviewSessionModel.find(
    { campaignId: s.campaignId, _id: { $ne: s._id } },
    { _id: 1 },
  ).lean();
  if (others.length === 0) return result;
  const otherIds = others.map((o) => o._id);

  for (const attempt of mine) {
    const sub = attempt.submission!;
    const problem = await ProblemModel.findById(attempt.problemId, {
      key: 1,
      'content.title': 1,
      'content.starterCode': 1,
    }).lean<ProblemRecord>();
    if (!problem) continue;
    const versions = await ProblemModel.find({ key: problem.key }, { _id: 1 }).lean();
    const candidates = await CodingAttemptModel.find(
      {
        sessionId: { $in: otherIds },
        problemId: { $in: versions.map((v) => v._id) },
        userId: { $ne: s.userId },
        'submission.language': sub.language,
      },
      { sessionId: 1, userId: 1, submission: 1 },
    ).lean<CodingAttemptRecord[]>();
    const starter = problem.content.starterCode[sub.language] ?? '';
    for (const other of candidates) {
      if (!other.submission) continue;
      const score = compareSubmissions(sub.code, other.submission.code, sub.language, starter);
      result.compared++;
      if (!score || score.similarity < opts.threshold) continue;
      // One record per pair, in a stable order whichever interview found it.
      const [a, b] = [attempt, other].sort((x, y) => String(x._id).localeCompare(String(y._id)));
      await CodeSimilarityFlagModel.updateOne(
        { 'a.attemptId': a!._id, 'b.attemptId': b!._id },
        {
          $set: {
            campaignId: s.campaignId,
            problemKey: problem.key,
            problemTitle: problem.content.title,
            a: { attemptId: a!._id, sessionId: a!.sessionId, userId: a!.userId },
            b: { attemptId: b!._id, sessionId: b!.sessionId, userId: b!.userId },
            language: sub.language,
            similarity: score.similarity,
            containment: score.containment,
            threshold: opts.threshold,
            algorithmVersion: SIMILARITY_ALGORITHM_VERSION,
            computedAt: opts.now ?? new Date(),
          },
        },
        { upsert: true },
      );
      result.flagged++;
    }
  }
  if (result.flagged > 0) {
    opts.logger.info({ sessionId: opts.sessionId, ...result }, 'similar code flagged for review');
  }
  return result;
}
