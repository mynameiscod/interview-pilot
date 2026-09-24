import { createHash } from 'node:crypto';
import type { Logger } from '@cbi/config';
import {
  CodingAttemptModel,
  InterviewSessionModel,
  InterviewTurnModel,
  ProblemModel,
  type CodingAttemptRecord,
  type InterviewSessionRecord,
  type InterviewTurnRecord,
  type ProblemRecord,
} from '@cbi/db';
import type { QuestionTarget } from '@cbi/interview-engine';
import { JudgeUnavailableError, runOnJudge, type JudgeAdapter } from '@cbi/provider-adapters';
import {
  ANSWER_LIMITS,
  CODING_LANGUAGE_LABELS,
  CODING_LIMITS,
  toRunResult,
  type AnswerTextPayload,
  type CodeRunResult,
  type CodingLanguage,
  type CodingWorkspace,
  type CreateProblemVersionBody,
  type ProblemSummary,
  type PublicProblem,
  type SaveCodeBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';

type Session = InterviewSessionRecord;

const LIVE = new Set(['ACTIVE', 'ROUND_TRANSITION']);

export const publicProblem = (p: ProblemRecord): PublicProblem => ({
  id: String(p._id),
  title: p.content.title,
  statement: p.content.statement,
  difficulty: p.content.difficulty,
  languages: p.content.languages,
  starterCode: p.content.starterCode,
  visibleTests: p.content.visibleTests,
  hiddenTestCount: p.content.hiddenTests.length,
  limits: p.content.limits,
});

export const problemSummary = (p: ProblemRecord): ProblemSummary => ({
  ...p.content,
  id: String(p._id),
  key: p.key,
  version: p.version,
  active: p.active,
  createdAt: iso(p.createdAt),
});

/** The turn text for a coding question (the transcript and follow-up prompts use it). */
export function codingQuestionText(p: ProblemRecord): string {
  const first = p.content.statement.split(/\n\s*\n/)[0] ?? '';
  return `Coding problem: ${p.content.title}. ${first}`.slice(0, 1500);
}

/** The answer recorded for a submitted solution: the result summary and the code. */
export function submissionAnswerText(opts: {
  language: CodingLanguage;
  code: string;
  result: CodeRunResult | null;
}): string {
  const head = opts.result
    ? `Submitted a ${CODING_LANGUAGE_LABELS[opts.language]} solution: ${opts.result.passed} of ${opts.result.total} tests passed (${opts.result.verdict.toLowerCase().replace('_', ' ')}).`
    : `Submitted a ${CODING_LANGUAGE_LABELS[opts.language]} solution. The code judge was unavailable, so it was not run.`;
  const room = ANSWER_LIMITS.maxChars - head.length - 20;
  const code = opts.code.length > room ? `${opts.code.slice(0, room)}\n…` : opts.code;
  return `${head}\n\n${code}`;
}

interface Deps {
  judge: JudgeAdapter;
  audit: AuditService;
  logger: Logger;
  /** The live service's answer path (submitting answers the coding question). */
  answer: (
    userId: string,
    payload: AnswerTextPayload,
    opts: { coding: true },
  ) => Promise<{ duplicate: boolean }>;
  now?: () => Date;
}

export function createCodingService(deps: Deps) {
  const { judge, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function context(userId: string, sessionId: string, questionId: string) {
    const s = await InterviewSessionModel.findOne({
      _id: objectId(sessionId, 'Interview'),
      userId,
    }).lean<Session>();
    if (!s) throw AppError.notFound('Interview not found');
    const turn = await InterviewTurnModel.findOne({
      sessionId: s._id,
      questionId,
    }).lean<InterviewTurnRecord>();
    if (!turn?.question.coding) throw AppError.notFound('Coding question not found');
    const problem = await ProblemModel.findById(
      turn.question.coding.problemId,
    ).lean<ProblemRecord>();
    if (!problem) throw AppError.notFound('Problem not found');
    return { s, turn, problem };
  }

  async function attemptFor(s: Session, turn: InterviewTurnRecord, problem: ProblemRecord) {
    const language = problem.content.languages[0]!;
    return (await CodingAttemptModel.findOneAndUpdate(
      { sessionId: s._id, questionId: turn.questionId },
      {
        $setOnInsert: {
          sessionId: s._id,
          userId: s.userId,
          questionId: turn.questionId,
          problemId: problem._id,
          language,
          code: problem.content.starterCode[language] ?? '',
        },
      },
      { upsert: true, returnDocument: 'after' },
    ).lean<CodingAttemptRecord>())!;
  }

  function workspace(problem: ProblemRecord, a: CodingAttemptRecord): CodingWorkspace {
    return {
      questionId: a.questionId,
      problem: publicProblem(problem),
      language: a.language,
      code: a.code,
      autosavedAt: a.autosavedAt ? iso(a.autosavedAt) : null,
      lastRun: a.lastRun,
      submission: a.submission
        ? {
            at: iso(a.submission.at),
            language: a.submission.language,
            result: a.submission.result,
            judgeUnavailable: a.submission.judgeUnavailable,
          }
        : null,
    };
  }

  function assertOpen(s: Session, turn: InterviewTurnRecord, a: CodingAttemptRecord) {
    if (!LIVE.has(s.state))
      throw new AppError(409, 'INVALID_STATE', 'The interview is not active.');
    if (turn.answer || a.submission) {
      throw new AppError(409, 'INVALID_STATE', 'This solution was already submitted.');
    }
  }

  function assertLanguage(problem: ProblemRecord, body: SaveCodeBody) {
    if (!problem.content.languages.includes(body.language)) {
      throw AppError.validation('That language is not available for this problem.');
    }
    if (Buffer.byteLength(body.code, 'utf8') > CODING_LIMITS.maxCodeBytes) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The code is too long.');
    }
  }

  async function save(a: CodingAttemptRecord, body: SaveCodeBody) {
    return (await CodingAttemptModel.findOneAndUpdate(
      { _id: a._id, submission: null },
      { $set: { language: body.language, code: body.code, autosavedAt: now() } },
      { returnDocument: 'after' },
    ).lean<CodingAttemptRecord>())!;
  }

  /** Runs code on the judge; JudgeUnavailableError when it cannot. */
  async function judgeRun(problem: ProblemRecord, body: SaveCodeBody, withHidden: boolean) {
    const tests = [
      ...problem.content.visibleTests.map((t) => ({ ...t, hidden: false })),
      ...(withHidden ? problem.content.hiddenTests.map((t) => ({ ...t, hidden: true })) : []),
    ];
    const judged = await runOnJudge(
      judge,
      {
        language: body.language,
        source: body.code,
        tests: tests.map((t) => ({ input: t.input, expectedOutput: t.expectedOutput })),
        limits: problem.content.limits,
      },
      { waitMs: CODING_LIMITS.judgeWaitMs },
    );
    return toRunResult(judged, tests, now());
  }

  return {
    /**
     * A problem for a coding round: the round's difficulty (or any), not seen
     * by this candidate in their recent attempts, chosen deterministically
     * per interview. Null when the bank is empty (the round asks a question).
     */
    async pickProblem(s: Session, target: QuestionTarget): Promise<ProblemRecord | null> {
      const recent = await CodingAttemptModel.find({ userId: s.userId }, { problemId: 1 })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
      const seen = new Set(recent.map((r) => String(r.problemId)));
      const active = await ProblemModel.find({ active: true })
        .sort({ key: 1 })
        .lean<ProblemRecord[]>();
      if (active.length === 0) return null;
      const fresh = active.filter((p) => !seen.has(String(p._id)));
      const pool = fresh.length ? fresh : active;
      const sameLevel = pool.filter((p) => p.content.difficulty === target.difficulty);
      const choices = sameLevel.length ? sameLevel : pool;
      const h = createHash('sha256')
        .update(`${String(s._id)}:${target.roundIdx}`)
        .digest();
      return choices[h.readUInt32BE(0) % choices.length]!;
    },

    async workspace(userId: string, sessionId: string, questionId: string) {
      const { s, turn, problem } = await context(userId, sessionId, questionId);
      return workspace(problem, await attemptFor(s, turn, problem));
    },

    /** Autosave (every few seconds and on blur while the candidate types). */
    async save(userId: string, sessionId: string, questionId: string, body: SaveCodeBody) {
      const { s, turn, problem } = await context(userId, sessionId, questionId);
      assertLanguage(problem, body);
      const a = await attemptFor(s, turn, problem);
      assertOpen(s, turn, a);
      return workspace(problem, await save(a, body));
    },

    /** Runs the visible tests. 503 JUDGE_UNAVAILABLE when the judge cannot run it (the code is saved). */
    async run(userId: string, sessionId: string, questionId: string, body: SaveCodeBody) {
      const { s, turn, problem } = await context(userId, sessionId, questionId);
      assertLanguage(problem, body);
      const a = await attemptFor(s, turn, problem);
      assertOpen(s, turn, a);
      await save(a, body);
      let result: CodeRunResult;
      try {
        result = await judgeRun(problem, body, false);
      } catch (err) {
        if (!(err instanceof JudgeUnavailableError)) throw err;
        logger.warn({ err, sessionId }, 'code run: judge unavailable');
        throw new AppError(
          503,
          'JUDGE_UNAVAILABLE',
          'Running code is temporarily unavailable. You can keep working and still submit.',
        );
      }
      const updated = await CodingAttemptModel.findOneAndUpdate(
        { _id: a._id },
        { $set: { lastRun: result }, $inc: { runCount: 1 } },
        { returnDocument: 'after' },
      ).lean<CodingAttemptRecord>();
      return workspace(problem, updated!);
    },

    /**
     * Submits the solution: judged against visible and hidden tests when the
     * judge is available, recorded either way, and the coding question is
     * answered so the interview moves on. Never fails because of the judge.
     */
    async submit(
      userId: string,
      sessionId: string,
      questionId: string,
      body: SaveCodeBody,
      ctx: ClientContext,
    ) {
      const { s, turn, problem } = await context(userId, sessionId, questionId);
      assertLanguage(problem, body);
      const a = await attemptFor(s, turn, problem);
      if (a.submission) return workspace(problem, a); // double click / retry
      assertOpen(s, turn, a);
      let result: CodeRunResult | null = null;
      try {
        result = await judgeRun(problem, body, true);
      } catch (err) {
        if (!(err instanceof JudgeUnavailableError)) throw err;
        logger.warn({ err, sessionId }, 'code submit: judge unavailable; submitting without a run');
      }
      const submitted = await CodingAttemptModel.findOneAndUpdate(
        { _id: a._id, submission: null },
        {
          $set: {
            language: body.language,
            code: body.code,
            autosavedAt: now(),
            submission: {
              at: now(),
              language: body.language,
              code: body.code,
              result,
              judgeUnavailable: result === null,
              source: 'CANDIDATE',
            },
          },
        },
        { returnDocument: 'after' },
      ).lean<CodingAttemptRecord>();
      const final =
        submitted ?? (await CodingAttemptModel.findById(a._id).lean<CodingAttemptRecord>())!;
      if (submitted) {
        await deps.answer(
          userId,
          {
            sessionId,
            questionId,
            text: submissionAnswerText({ language: body.language, code: body.code, result }),
            clientMsgId: `coding-${questionId}`.slice(0, 64),
          },
          { coding: true },
        );
        await audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'interview.code_submitted',
            resourceType: 'interviewSession',
            resourceId: sessionId,
            details: {
              problem: problem.key,
              language: body.language,
              passed: result?.passed ?? null,
              total: result?.total ?? null,
              judgeUnavailable: result === null,
            },
          },
          ctx,
        );
      }
      return workspace(problem, final);
    },

    // ---- Admin: the problem bank ------------------------------------------------------------

    async listProblems(): Promise<ProblemSummary[]> {
      const rows = await ProblemModel.find().sort({ key: 1, version: -1 }).lean<ProblemRecord[]>();
      return rows.map(problemSummary);
    },

    async createProblemVersion(
      body: CreateProblemVersionBody,
      actorId: string,
      ctx: ClientContext,
    ) {
      return transaction(async (session) => {
        const latest = await ProblemModel.findOne({ key: body.key }, { version: 1 }, { session })
          .sort({ version: -1 })
          .lean();
        const [p] = await ProblemModel.create(
          [
            {
              key: body.key,
              version: (latest?.version ?? 0) + 1,
              active: false,
              content: body.content,
              createdBy: actorId,
              reason: body.reason,
            },
          ],
          { session },
        );
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'coding.problem_created',
            resourceType: 'problem',
            resourceId: String(p!._id),
            details: { key: body.key, version: p!.version, reason: body.reason },
          },
          ctx,
          session,
        );
        return problemSummary(p!.toObject());
      });
    },

    async setProblemActive(
      id: string,
      active: boolean,
      reason: string,
      actorId: string,
      ctx: ClientContext,
    ) {
      const pid = objectId(id, 'Problem');
      return transaction(async (session) => {
        const p = await ProblemModel.findById(pid, null, { session }).lean<ProblemRecord>();
        if (!p) throw AppError.notFound('Problem not found');
        if (active) {
          await ProblemModel.updateMany(
            { key: p.key, active: true, _id: { $ne: pid } },
            { $set: { active: false } },
            { session },
          );
        }
        await ProblemModel.updateOne({ _id: pid }, { $set: { active } }, { session });
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: active ? 'coding.problem_activated' : 'coding.problem_deactivated',
            resourceType: 'problem',
            resourceId: id,
            details: { key: p.key, version: p.version, reason },
          },
          ctx,
          session,
        );
        return problemSummary({ ...p, active });
      });
    },
  };
}

export type CodingService = ReturnType<typeof createCodingService>;
