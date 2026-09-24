import type { Logger } from '@cbi/config';
import {
  CodingAttemptModel,
  ProblemModel,
  type CodingAttemptRecord,
  type InterviewTurnRecord,
  type ProblemRecord,
} from '@cbi/db';
import { JudgeUnavailableError, runOnJudge, type JudgeAdapter } from '@cbi/provider-adapters';
import {
  CODING_LIMITS,
  codingStrength,
  submissionAnswerText,
  toRunResult,
  type BlueprintContent,
  type CodeRunResult,
  type CodingReportItem,
} from '@cbi/shared-types';
import type { Types } from 'mongoose';

/**
 * Coding in evaluation (Phase 9): judge-derived evidence merged with the AI's
 * reading of the code. Judge results are deterministic evidence; when the
 * judge could not run the code, evidence about that code is less confident.
 */

export interface CodingContext {
  attempts: CodingAttemptRecord[];
  problems: Map<string, ProblemRecord>;
}

export async function loadCoding(sessionId: Types.ObjectId): Promise<CodingContext> {
  const attempts = await CodingAttemptModel.find({ sessionId }).lean<CodingAttemptRecord[]>();
  const problems = await ProblemModel.find({
    _id: { $in: attempts.map((a) => a.problemId) },
  }).lean<ProblemRecord[]>();
  return { attempts, problems: new Map(problems.map((p) => [String(p._id), p])) };
}

/**
 * Code written but never submitted (time ran out, or the interview ended)
 * is judged now and recorded as an automatic submission. Idempotent.
 */
export async function judgeUnsubmitted(
  sessionId: Types.ObjectId,
  judge: JudgeAdapter | null,
  logger: Logger,
  now = new Date(),
): Promise<number> {
  const { attempts, problems } = await loadCoding(sessionId);
  let judged = 0;
  for (const a of attempts) {
    if (a.submission) continue;
    const problem = problems.get(String(a.problemId));
    const starter = problem?.content.starterCode[a.language] ?? '';
    if (!problem || !a.code.trim() || a.code === starter) continue;
    const tests = [
      ...problem.content.visibleTests.map((t) => ({ ...t, hidden: false })),
      ...problem.content.hiddenTests.map((t) => ({ ...t, hidden: true })),
    ];
    let result: CodeRunResult | null = null;
    if (judge) {
      try {
        const out = await runOnJudge(
          judge,
          {
            language: a.language,
            source: a.code,
            tests: tests.map((t) => ({ input: t.input, expectedOutput: t.expectedOutput })),
            limits: problem.content.limits,
          },
          { waitMs: CODING_LIMITS.judgeWaitMs },
        );
        result = toRunResult(out, tests, now);
      } catch (err) {
        if (!(err instanceof JudgeUnavailableError)) throw err;
        logger.warn(
          { err, sessionId: String(sessionId) },
          'judge unavailable for an unsubmitted solution',
        );
      }
    }
    const res = await CodingAttemptModel.updateOne(
      { _id: a._id, submission: null },
      {
        $set: {
          submission: {
            at: now,
            language: a.language,
            code: a.code,
            result,
            judgeUnavailable: result === null,
            source: 'AUTO',
          },
        },
      },
    );
    judged += res.modifiedCount;
  }
  return judged;
}

/** Turns of a round with the answer text evaluation should read (unanswered coding turns use the saved code). */
export function answeredWithCode(
  turns: readonly InterviewTurnRecord[],
  coding: CodingContext,
): { turn: InterviewTurnRecord; text: string; spoken: boolean }[] {
  const byQuestion = new Map(coding.attempts.map((a) => [a.questionId, a]));
  return turns.flatMap((t) => {
    if (t.answer?.text.trim()) {
      return [{ turn: t, text: t.answer.text, spoken: t.answer.source === 'VOICE' }];
    }
    const a = t.question.coding ? byQuestion.get(t.questionId) : undefined;
    if (a?.submission) {
      const text = submissionAnswerText({
        language: a.submission.language,
        code: a.submission.code,
        result: a.submission.result,
      });
      return [{ turn: t, text: `(Not submitted before time ran out.) ${text}`, spoken: false }];
    }
    return [];
  });
}

interface EvidenceItem {
  questionId: string;
  competencyKey: string;
  claim: string;
  strength: number;
  confidence: number;
  practical: boolean;
  quote: string | null;
  uncertainty: string | null;
  extractorVersion: number | null;
}

/** The competency coding evidence counts towards: the question's, else the first technical one. */
function codingCompetency(turn: InterviewTurnRecord, blueprint: BlueprintContent): string | null {
  const keys = new Set(blueprint.competencies.map((c) => c.key));
  if (turn.question.competencyKey && keys.has(turn.question.competencyKey)) {
    return turn.question.competencyKey;
  }
  return (
    blueprint.competencies.find((c) => c.category === 'TECHNICAL')?.key ??
    blueprint.competencies[0]?.key ??
    null
  );
}

/**
 * Adds judge evidence for each coding question in a round and lowers the
 * confidence of the AI's evidence about code the judge could not run.
 */
export function mergeCodingEvidence(
  items: EvidenceItem[],
  roundTurns: readonly InterviewTurnRecord[],
  coding: CodingContext,
  blueprint: BlueprintContent,
): EvidenceItem[] {
  const out = [...items];
  for (const turn of roundTurns) {
    if (!turn.question.coding) continue;
    const a = coding.attempts.find((x) => x.questionId === turn.questionId);
    const sub = a?.submission;
    if (!sub) continue;
    const competencyKey = codingCompetency(turn, blueprint);
    if (!competencyKey) continue;
    if (sub.result) {
      const r = sub.result;
      const compiled = r.verdict !== 'COMPILE_ERROR';
      out.push({
        questionId: turn.questionId,
        competencyKey,
        claim: compiled
          ? `The solution to "${turn.question.coding.title}" passed ${r.passed} of ${r.total} tests${sub.source === 'AUTO' ? ' (judged after time ran out, not submitted)' : ''}.`
          : `The solution to "${turn.question.coding.title}" did not compile.`,
        strength: codingStrength(r.passed, r.total, compiled),
        confidence: 0.9,
        practical: true,
        quote: null,
        uncertainty: null,
        extractorVersion: null,
      });
    } else {
      for (const item of out) {
        if (item.questionId !== turn.questionId) continue;
        item.confidence = Math.min(item.confidence, 0.5);
        item.uncertainty = [
          item.uncertainty,
          'The code judge was unavailable; the code was not run.',
        ]
          .filter(Boolean)
          .join(' ');
      }
    }
  }
  return out;
}

export function codingReport(
  coding: CodingContext,
  turns: readonly InterviewTurnRecord[],
): CodingReportItem[] {
  return turns
    .filter((t) => t.question.coding)
    .map((t) => {
      const a = coding.attempts.find((x) => x.questionId === t.questionId);
      const problem = coding.problems.get(String(t.question.coding!.problemId));
      const sub = a?.submission ?? null;
      return {
        title: t.question.coding!.title,
        difficulty: problem?.content.difficulty ?? t.question.difficulty,
        language: sub?.language ?? a?.language ?? null,
        submitted: sub?.source === 'CANDIDATE',
        passed: sub?.result?.passed ?? null,
        total: sub?.result?.total ?? null,
        verdict: sub?.result?.verdict ?? null,
        judgeUnavailable: Boolean(sub?.judgeUnavailable),
      };
    });
}
