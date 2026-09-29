import { createHash } from 'node:crypto';
import type { Logger } from '@cbi/config';
import {
  DesignAttemptModel,
  DesignPromptModel,
  InterviewSessionModel,
  InterviewTurnModel,
  type DesignAttemptRecord,
  type DesignPromptRecord,
  type InterviewSessionRecord,
  type InterviewTurnRecord,
} from '@cbi/db';
import type { QuestionTarget } from '@cbi/interview-engine';
import {
  designAnswerText,
  diagramText,
  EMPTY_DIAGRAM,
  EMPTY_NOTES,
  notesText,
  type AnswerTextPayload,
  type CreateDesignPromptVersionBody,
  type DesignPromptSummary,
  type DesignWorkspace,
  type PublicDesignPrompt,
  type SaveDesignBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';
import { ANSWERABLE_STATES, LiveError } from '../live/live.service.js';

type Session = InterviewSessionRecord;

export const publicDesignPrompt = (p: DesignPromptRecord): PublicDesignPrompt => ({
  id: String(p._id),
  title: p.content.title,
  prompt: p.content.prompt,
  difficulty: p.content.difficulty,
  focusAreas: p.content.focusAreas,
});

export const designPromptSummary = (p: DesignPromptRecord): DesignPromptSummary => ({
  ...p.content,
  id: String(p._id),
  key: p.key,
  version: p.version,
  active: p.active,
  createdAt: iso(p.createdAt),
});

/** The turn text for a design question (the transcript and the probes use it). */
export function designQuestionText(p: DesignPromptRecord): string {
  const first = p.content.prompt.split(/\n\s*\n/)[0] ?? '';
  return `System design: ${p.content.title}. ${first}`.slice(0, 1500);
}

interface Deps {
  audit: AuditService;
  logger: Logger;
  /** The live service's answer path (submitting the design answers the question). */
  answer: (
    userId: string,
    payload: AnswerTextPayload,
    opts: { design: true },
  ) => Promise<{ duplicate: boolean }>;
  now?: () => Date;
}

/**
 * System design rounds: the whiteboard and notes of a design question
 * (autosaved, then submitted once), the prompt picker, the design as text
 * for the interviewer's probes, and the admin design bank.
 */
export function createDesignService(deps: Deps) {
  const { audit, logger } = deps;
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
    if (!turn?.question.design) throw AppError.notFound('Design question not found');
    const prompt = await DesignPromptModel.findById(
      turn.question.design.promptId,
    ).lean<DesignPromptRecord>();
    if (!prompt) throw AppError.notFound('Design prompt not found');
    return { s, turn, prompt };
  }

  async function attemptFor(s: Session, turn: InterviewTurnRecord, prompt: DesignPromptRecord) {
    return (await DesignAttemptModel.findOneAndUpdate(
      { sessionId: s._id, questionId: turn.questionId },
      {
        $setOnInsert: {
          sessionId: s._id,
          userId: s.userId,
          questionId: turn.questionId,
          roundIdx: turn.roundIdx,
          promptId: prompt._id,
          notes: EMPTY_NOTES,
          diagram: EMPTY_DIAGRAM,
        },
      },
      { upsert: true, returnDocument: 'after' },
    ).lean<DesignAttemptRecord>())!;
  }

  const workspace = (prompt: DesignPromptRecord, a: DesignAttemptRecord): DesignWorkspace => ({
    questionId: a.questionId,
    prompt: publicDesignPrompt(prompt),
    notes: a.notes,
    diagram: a.diagram,
    autosavedAt: a.autosavedAt ? iso(a.autosavedAt) : null,
    submittedAt: a.submittedAt ? iso(a.submittedAt) : null,
  });

  /** The whiteboard is open while the question can be answered. */
  function assertOpen(s: Session, turn: InterviewTurnRecord, a: DesignAttemptRecord) {
    if (!ANSWERABLE_STATES.has(s.state))
      throw new AppError(409, 'INVALID_STATE', 'The interview is not active.');
    if (turn.answer || a.submittedAt) {
      throw new AppError(409, 'INVALID_STATE', 'This design was already submitted.');
    }
  }

  async function answerDesign(
    userId: string,
    sessionId: string,
    questionId: string,
    a: Pick<DesignAttemptRecord, 'notes' | 'diagram'>,
  ) {
    try {
      await deps.answer(
        userId,
        {
          sessionId,
          questionId,
          text: designAnswerText(a.notes, a.diagram),
          clientMsgId: `design-${questionId}`.slice(0, 64),
        },
        { design: true },
      );
    } catch (err) {
      if (!(err instanceof LiveError)) throw err;
      logger.warn({ err, sessionId }, 'design submit: answering the question failed');
      if (err.code === 'BUSY') {
        throw new AppError(
          503,
          'SERVICE_UNAVAILABLE',
          'Your design is saved. Please submit again to continue.',
        );
      }
      throw new AppError(409, 'INVALID_STATE', err.message);
    }
  }

  return {
    /**
     * A prompt for a system design round: the round's difficulty (or any),
     * not seen by this candidate in their recent designs, chosen
     * deterministically per interview and round. Null when the bank is empty.
     */
    async pickPrompt(s: Session, target: QuestionTarget): Promise<DesignPromptRecord | null> {
      const recent = await DesignAttemptModel.find({ userId: s.userId }, { promptId: 1 })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
      const seen = new Set(recent.map((r) => String(r.promptId)));
      const active = await DesignPromptModel.find({ active: true })
        .sort({ key: 1 })
        .lean<DesignPromptRecord[]>();
      if (active.length === 0) return null;
      const fresh = active.filter((p) => !seen.has(String(p._id)));
      const pool = fresh.length ? fresh : active;
      const sameLevel = pool.filter((p) => p.content.difficulty === target.difficulty);
      const choices = sameLevel.length ? sameLevel : pool;
      const h = createHash('sha256')
        .update(`design:${String(s._id)}:${target.roundIdx}`)
        .digest();
      return choices[h.readUInt32BE(0) % choices.length]!;
    },

    /** The design of a round as text for the probes (null before the design question). */
    async designContext(s: Session, roundIdx: number) {
      const turn = await InterviewTurnModel.findOne(
        { sessionId: s._id, roundIdx, 'question.design': { $ne: null } },
        { questionId: 1, question: 1 },
      ).lean<InterviewTurnRecord>();
      if (!turn?.question.design) return null;
      const [prompt, attempt] = await Promise.all([
        DesignPromptModel.findById(turn.question.design.promptId).lean<DesignPromptRecord>(),
        DesignAttemptModel.findOne({
          sessionId: s._id,
          questionId: turn.questionId,
        }).lean<DesignAttemptRecord>(),
      ]);
      const notes = attempt?.notes ?? EMPTY_NOTES;
      const diagram = attempt?.diagram ?? EMPTY_DIAGRAM;
      return {
        title: turn.question.design.title,
        prompt: prompt?.content.prompt ?? '',
        design: `Notes:\n${notesText(notes)}\n\nDiagram:\n${diagramText(diagram)}`,
      };
    },

    async workspace(userId: string, sessionId: string, questionId: string) {
      const { s, turn, prompt } = await context(userId, sessionId, questionId);
      return workspace(prompt, await attemptFor(s, turn, prompt));
    },

    /** Autosave of the whiteboard and notes (every few seconds while the candidate works). */
    async save(userId: string, sessionId: string, questionId: string, body: SaveDesignBody) {
      const { s, turn, prompt } = await context(userId, sessionId, questionId);
      const a = await attemptFor(s, turn, prompt);
      assertOpen(s, turn, a);
      const saved = await DesignAttemptModel.findOneAndUpdate(
        { _id: a._id, submittedAt: null },
        { $set: { notes: body.notes, diagram: body.diagram, autosavedAt: now() } },
        { returnDocument: 'after' },
      ).lean<DesignAttemptRecord>();
      if (!saved) throw new AppError(409, 'INVALID_STATE', 'This design was already submitted.');
      return workspace(prompt, saved);
    },

    /**
     * Submits the design: it is saved, becomes read-only and answers the
     * question, so the interviewer's probes follow. A retry answers the
     * question if that failed after the design was saved (idempotent).
     */
    async submit(
      userId: string,
      sessionId: string,
      questionId: string,
      body: SaveDesignBody,
      ctx: ClientContext,
    ) {
      const { s, turn, prompt } = await context(userId, sessionId, questionId);
      const a = await attemptFor(s, turn, prompt);
      if (a.submittedAt) {
        if (!turn.answer) await answerDesign(userId, sessionId, questionId, a);
        return workspace(prompt, a);
      }
      assertOpen(s, turn, a);
      const submitted = await DesignAttemptModel.findOneAndUpdate(
        { _id: a._id, submittedAt: null },
        {
          $set: {
            notes: body.notes,
            diagram: body.diagram,
            autosavedAt: now(),
            submittedAt: now(),
          },
        },
        { returnDocument: 'after' },
      ).lean<DesignAttemptRecord>();
      const final =
        submitted ?? (await DesignAttemptModel.findById(a._id).lean<DesignAttemptRecord>())!;
      if (submitted) {
        await answerDesign(userId, sessionId, questionId, submitted);
        await audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'interview.design_submitted',
            resourceType: 'interviewSession',
            resourceId: sessionId,
            details: {
              prompt: prompt.key,
              boxes: body.diagram.nodes.length,
              arrows: body.diagram.edges.length,
            },
          },
          ctx,
        );
      }
      return workspace(prompt, final);
    },

    // ---- Admin: the design bank ---------------------------------------------------------------

    async listPrompts(): Promise<DesignPromptSummary[]> {
      const rows = await DesignPromptModel.find()
        .sort({ key: 1, version: -1 })
        .lean<DesignPromptRecord[]>();
      return rows.map(designPromptSummary);
    },

    async createPromptVersion(
      body: CreateDesignPromptVersionBody,
      actorId: string,
      ctx: ClientContext,
    ) {
      return transaction(async (session) => {
        const latest = await DesignPromptModel.findOne(
          { key: body.key },
          { version: 1 },
          { session },
        )
          .sort({ version: -1 })
          .lean();
        const [p] = await DesignPromptModel.create(
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
            action: 'design.prompt_created',
            resourceType: 'designPrompt',
            resourceId: String(p!._id),
            details: { key: body.key, version: p!.version, reason: body.reason },
          },
          ctx,
          session,
        );
        return designPromptSummary(p!.toObject());
      });
    },

    async setPromptActive(
      id: string,
      active: boolean,
      reason: string,
      actorId: string,
      ctx: ClientContext,
    ) {
      const pid = objectId(id, 'Design prompt');
      return transaction(async (session) => {
        const p = await DesignPromptModel.findById(pid, null, {
          session,
        }).lean<DesignPromptRecord>();
        if (!p) throw AppError.notFound('Design prompt not found');
        if (active) {
          await DesignPromptModel.updateMany(
            { key: p.key, active: true, _id: { $ne: pid } },
            { $set: { active: false } },
            { session },
          );
        }
        await DesignPromptModel.updateOne({ _id: pid }, { $set: { active } }, { session });
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: active ? 'design.prompt_activated' : 'design.prompt_deactivated',
            resourceType: 'designPrompt',
            resourceId: id,
            details: { key: p.key, version: p.version, reason },
          },
          ctx,
          session,
        );
        return designPromptSummary({ ...p, active });
      });
    },
  };
}

export type DesignService = ReturnType<typeof createDesignService>;
