import { randomUUID } from 'node:crypto';
import { renderPrompt, untrusted, type PromptValue } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import {
  CampaignModel,
  applySessionEvent,
  grantFreeCredits,
  inTransaction,
  InsufficientCreditsError,
  InterviewSessionModel,
  InterviewTemplateModel,
  InterviewTurnModel,
  RoleBlueprintModel,
  sessionElapsedMs,
  sessionRemainingMs,
  type InterviewSessionRecord,
  type InterviewTurnRecord,
  type Redis,
} from '@cbi/db';
import {
  createPlanner,
  endCurrentRound,
  nextStep,
  recordAssessment,
  recordQuestion,
  type PlannerState,
  type QuestionTarget,
  type SessionEvent,
} from '@cbi/interview-engine';
import {
  AssessTurnAi,
  InterviewQuestionAi,
  RtEvent,
  type AiFeature,
  type AnswerTextPayload,
  type BlueprintContent,
  type InterviewSnapshot,
  type LiveQuestion,
  type RtErrorCode,
  type MaintenanceSetting,
} from '@cbi/shared-types';
import type { Types } from 'mongoose';
import type { z } from 'zod';
import type { AuditService } from '../../lib/audit.js';
import type { JobQueues } from '../../lib/jobs.js';
import { refuseDuringMaintenance } from '../../lib/maintenance.js';
import { AppError } from '../../lib/errors.js';
import { objectId } from '../../lib/ids.js';
import { LOCK_BUSY, withLock } from '../../lib/lock.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { ConsentService } from '../consent/consent.service.js';
import type { TranscriptStore } from '../voice/voice.service.js';

/** Where realtime events go; attached once the Socket.IO server exists. */
export interface RoomEmitter {
  emit(sessionId: string, event: string, payload: unknown): void;
}

export function createRoomEmitter() {
  let target: ((room: string, event: string, payload: unknown) => void) | null = null;
  const emitter: RoomEmitter & {
    attach(fn: (room: string, event: string, payload: unknown) => void): void;
    detach(): void;
  } = {
    attach(fn) {
      target = fn;
    },
    detach() {
      target = null;
    },
    /** Best effort: clients that miss an event catch up from the snapshot on (re)join. */
    emit(sessionId, event, payload) {
      try {
        target?.(roomOf(sessionId), event, payload);
      } catch {
        // Delivery problems must never break turn processing.
      }
    },
  };
  return emitter;
}

export const roomOf = (sessionId: string) => `session:${sessionId}`;

export class LiveError extends Error {
  constructor(
    public readonly code: RtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LiveError';
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  auto: 'English',
  en: 'English',
  hi: 'Hindi',
  te: 'Telugu',
};

/** States a candidate can join to see (and continue) their interview. */
const JOINABLE = new Set([
  'ACTIVE',
  'ROUND_TRANSITION',
  'RECONNECTING',
  'PAUSED',
  'COMPLETING',
  'PROCESSING',
  'EXPIRED',
  'REPORT_READY',
  'FAILED',
]);

/** Text sent back to prompts: enough context without the whole transcript (design §6.3). */
const MAX_ASKED_IN_PROMPT = 15;
const TURN_LOCK_TTL_MS = 90_000;

/** Used when the question model is unavailable, so the interview can continue. */
export function fallbackQuestion(target: QuestionTarget): string {
  if (target.followUpOf) {
    return 'Could you go one level deeper on that? Walk me through a specific example, the decisions you made and the result.';
  }
  switch (target.roundType) {
    case 'INTRO':
      return 'To start, could you introduce yourself and the experience that is most relevant to this role?';
    case 'WRAP_UP':
      return 'We are nearly done. Is there anything about your experience that we have not covered and you would like to add?';
    case 'BEHAVIORAL':
      return `Tell me about a specific situation where you showed ${target.competencyName ?? 'ownership'}. What did you do, and what was the outcome?`;
    default:
      return target.probeTopic
        ? `Let's talk about ${target.probeTopic}. What was your role, what decisions did you make, and why?`
        : `How would you approach ${target.competencyName ?? 'a problem like this'} in your day-to-day work? Please use a concrete example.`;
  }
}

interface Deps {
  ai: AiRuntime;
  redis: Redis;
  logger: Logger;
  rooms: RoomEmitter;
  audit: AuditService;
  jobs: Pick<JobQueues, 'evaluateInterview'>;
  /** Spoken answers waiting to be submitted (voice interviews). */
  transcripts: TranscriptStore;
  /** Consents and device-check readiness (the start gate). */
  consent: ConsentService;
  /** Called after a question is asked (voice interviews prepare its audio). */
  onQuestion?: (s: InterviewSessionRecord, turn: InterviewTurnRecord) => void;
  /** Coding rounds: a problem from the bank for the round's first question (null: ask normally). */
  pickCodingProblem?: (
    s: InterviewSessionRecord,
    target: QuestionTarget,
  ) => Promise<{ _id: Types.ObjectId; title: string; text: string } | null>;
  /** Maintenance mode refuses new starts (running interviews continue). */
  maintenance?: () => Promise<MaintenanceSetting>;
  now?: () => Date;
}

type Session = InterviewSessionRecord;

export function createLiveInterviewService({
  ai,
  redis,
  logger,
  rooms,
  audit,
  jobs,
  transcripts,
  consent,
  onQuestion,
  pickCodingProblem,
  maintenance,
  now = () => new Date(),
}: Deps) {
  const blueprints = new Map<string, BlueprintContent>();

  /** Blueprint versions are immutable, so they are cached for the process lifetime. */
  async function blueprintOf(s: Session): Promise<BlueprintContent> {
    const id = String(s.blueprintId);
    const hit = blueprints.get(id);
    if (hit) return hit;
    const doc = await RoleBlueprintModel.findById(s.blueprintId).lean();
    if (!doc) throw new Error(`blueprint ${id} missing`);
    if (blueprints.size > 500) blueprints.clear();
    blueprints.set(id, doc.content);
    return doc.content;
  }

  async function load(sessionId: string, userId?: string) {
    return InterviewSessionModel.findOne({
      _id: objectId(sessionId, 'Interview'),
      ...(userId ? { userId } : {}),
    }).lean<Session>();
  }

  async function runAi<T>(
    feature: AiFeature,
    schema: z.ZodType<T>,
    values: Record<string, PromptValue>,
    s: Session,
  ): Promise<{ data: T; model: string; promptVersion: number } | null> {
    const prompt = await ai.prompts.getActive(feature);
    if (!prompt) {
      logger.error({ feature }, 'no active prompt');
      return null;
    }
    try {
      const result = await ai.router.run<T>(
        feature,
        {
          messages: renderPrompt(prompt, values),
          output: { name: feature.replace('.', '_'), schema },
        },
        {
          userId: String(s.userId),
          sessionId: String(s._id),
          prompt: { key: prompt.key, version: prompt.version },
        },
      );
      return { data: result.data, model: result.model.modelId, promptVersion: prompt.version };
    } catch (err) {
      logger.warn(
        { err, feature, sessionId: String(s._id) },
        'live ai call failed; using fallback',
      );
      return null;
    }
  }

  const bullets = (items: readonly string[]) =>
    items.length ? items.map((x) => `- ${x}`).join('\n') : '-';

  async function generateQuestion(
    s: Session,
    target: QuestionTarget,
    blueprint: BlueprintContent,
  ): Promise<{
    text: string;
    model: string | null;
    promptVersion: number | null;
    coding?: { problemId: Types.ObjectId; title: string };
  }> {
    // A coding round opens with a problem from the bank; its follow-ups are ordinary questions.
    if (target.roundType === 'CODING' && !target.followUpOf && pickCodingProblem) {
      const problem = await pickCodingProblem(s, target).catch((err: unknown) => {
        logger.error({ err, sessionId: String(s._id) }, 'coding problem selection failed');
        return null;
      });
      if (problem) {
        return {
          text: problem.text,
          model: null,
          promptVersion: null,
          coding: { problemId: problem._id, title: problem.title },
        };
      }
    }
    const previous = await InterviewTurnModel.find(
      { sessionId: s._id },
      { question: 1, answer: 1, questionId: 1 },
    )
      .sort({ seq: -1 })
      .limit(MAX_ASKED_IN_PROMPT)
      .lean();
    const parent = target.followUpOf
      ? previous.find((t) => t.questionId === target.followUpOf)
      : null;
    const background = [
      ...(s.analysis?.resumeHighlights ?? []).map((h) => `Resume: ${h}`),
      ...(s.analysis?.gaps ?? []).map((g) => `Gap to explore: ${g}`),
    ];
    const result = await runAi(
      'interview.question',
      InterviewQuestionAi,
      {
        language: LANGUAGE_NAMES[s.language] ?? 'English',
        role: `${blueprint.role.title} (${blueprint.role.seniority.toLowerCase()})`,
        roundType: target.roundType,
        objective: target.objective,
        competency: target.competencyName ?? 'General',
        difficulty: target.difficulty,
        expectedEvidence: bullets(target.expectedEvidence),
        background: untrusted(background.join('\n') || '-'),
        askedQuestions: untrusted(
          previous
            .map((t) => `- ${t.question.text}`)
            .reverse()
            .join('\n') || '-',
        ),
        thread: untrusted(
          parent ? `Question: ${parent.question.text}\nAnswer: ${parent.answer?.text ?? ''}` : '',
        ),
      },
      s,
    );
    return result
      ? { text: result.data.question, model: result.model, promptVersion: result.promptVersion }
      : { text: fallbackQuestion(target), model: null, promptVersion: null };
  }

  async function assessAnswer(s: Session, turn: InterviewTurnRecord, answer: string) {
    if (!answer.trim()) {
      return {
        sufficiency: 'NO_ANSWER' as const,
        followUpNeeded: false,
        followUpAngle: null,
        evidence: [],
        notes: 'Empty answer',
        promptVersion: null,
        model: null,
        fallback: false,
      };
    }
    const result = await runAi(
      'interview.assessTurn',
      AssessTurnAi,
      {
        roundType: turn.roundType,
        objective: turn.question.objective,
        competency: turn.question.competencyName ?? 'General',
        expectedEvidence: bullets(turn.question.expectedEvidence),
        question: turn.question.text,
        answer: untrusted(answer),
      },
      s,
    );
    if (result) {
      return {
        ...result.data,
        promptVersion: result.promptVersion,
        model: result.model,
        fallback: false,
      };
    }
    // Without an assessment the plan moves on as if the answer were adequate; Phase 5 re-evaluates.
    return {
      sufficiency: 'ADEQUATE' as const,
      followUpNeeded: false,
      followUpAngle: null,
      evidence: [],
      notes: null,
      promptVersion: null,
      model: null,
      fallback: true,
    };
  }

  function liveQuestion(t: InterviewTurnRecord): LiveQuestion {
    return {
      questionId: t.questionId,
      seq: t.seq,
      text: t.question.text,
      roundIdx: t.roundIdx,
      roundType: t.roundType,
      isFollowUp: t.question.followUpOf !== null,
      askedAt: t.askedAt.toISOString(),
      coding: t.question.coding
        ? { problemId: String(t.question.coding.problemId), title: t.question.coding.title }
        : null,
    };
  }

  async function snapshot(s: Session, lastSeq = 0): Promise<InterviewSnapshot> {
    const at = now();
    const [turns, current, template] = await Promise.all([
      InterviewTurnModel.find({ sessionId: s._id, seq: { $gt: lastSeq } })
        .sort({ seq: 1 })
        .limit(200)
        .lean(),
      InterviewTurnModel.findOne({ sessionId: s._id, seq: s.lastSeq, answer: null }).lean(),
      InterviewTemplateModel.findById(s.templateId, { content: 1 }).lean(),
    ]);
    const liveNow = s.state === 'ACTIVE' || s.state === 'ROUND_TRANSITION';
    return {
      sessionId: String(s._id),
      state: s.state,
      mode: s.mode,
      voiceEnabled: s.mode !== 'TEXT' || Boolean(s.voice?.spokenMode),
      recording: Boolean(s.recording?.enabled),
      integrityTracking: (s.consents ?? []).some((c) => c.type === 'INTEGRITY' && c.accepted),
      language: s.language,
      title: s.analysis?.detectedRole.title ?? template?.content.name ?? 'Interview',
      rounds: (s.planner?.rounds ?? []).map((r) => ({
        type: r.type,
        state: r.state,
        durationSec: Math.round(r.budgetMs / 1000),
      })),
      roundIdx: s.planner?.roundIdx ?? -1,
      budgetMs: s.clock?.budgetMs ?? 0,
      remainingMs: sessionRemainingMs(s, at),
      clockRunning: Boolean(s.clock?.runningSince),
      answeredCount: s.planner?.answeredCount ?? 0,
      currentQuestion: current && liveNow ? liveQuestion(current) : null,
      thinking: liveNow && !current,
      turns: turns.map((t) => ({
        seq: t.seq,
        questionId: t.questionId,
        roundIdx: t.roundIdx,
        question: t.question.text,
        answer: t.answer?.text ?? null,
        answerSource: t.answer ? (t.answer.source ?? 'TEXT') : null,
      })),
      lastSeq: s.lastSeq,
      serverTime: at.toISOString(),
    };
  }

  async function event(
    s: Session,
    e: SessionEvent,
    extra: { set?: Partial<Session>; reason?: string } = {},
  ) {
    const result = await applySessionEvent({
      sessionId: s._id,
      event: e,
      expectedVersion: s.stateVersion,
      now: now(),
      ...extra,
    });
    if (result.ok && result.effects.some((x) => x.type === 'ENQUEUE_EVALUATION')) {
      // If this fails the worker's evaluation sweep starts it within a minute.
      await jobs
        .evaluateInterview(String(s._id))
        .catch((err: unknown) =>
          logger.error({ err, sessionId: String(s._id) }, 'failed to enqueue evaluation'),
        );
    }
    return result;
  }

  async function finish(s: Session) {
    const done = await event(s, { type: 'FINALIZE' });
    const final = done.ok ? done.session : await load(String(s._id));
    if (final) {
      rooms.emit(String(s._id), RtEvent.COMPLETED, await snapshot(final));
    }
    return final;
  }

  /**
   * Moves the interview forward until it waits for the candidate: starts the
   * next round, ends rounds, finishes the interview, or asks the next
   * question. Must run under the session's turn lock.
   */
  async function advance(sessionId: string): Promise<void> {
    for (let guard = 0; guard < 20; guard++) {
      const s = await load(sessionId);
      if (!s) return;
      if (s.state === 'COMPLETING') {
        await finish(s);
        return;
      }
      if (s.state === 'ROUND_TRANSITION') {
        const r = await event(s, { type: 'NEXT_ROUND' });
        if (r.ok) {
          const p = r.session.planner!;
          rooms.emit(sessionId, RtEvent.ROUND_TRANSITION, {
            fromRoundIdx: p.roundIdx - 1,
            toRoundIdx: p.roundIdx,
            toRoundType: p.rounds[p.roundIdx]!.type,
          });
        }
        continue;
      }
      if (s.state !== 'ACTIVE' || !s.planner) return;

      const at = now();
      if (sessionRemainingMs(s, at) <= 0) {
        await event(s, { type: 'TIME_UP' });
        continue;
      }
      // A question is already waiting for an answer.
      if (
        s.lastSeq > 0 &&
        (await InterviewTurnModel.exists({ sessionId: s._id, seq: s.lastSeq, answer: null }))
      ) {
        return;
      }

      const blueprint = await blueprintOf(s);
      const step = nextStep(s.planner, blueprint, sessionElapsedMs(s, at));
      if (step.kind === 'END_ROUND') {
        await event(
          s,
          { type: 'ROUND_ENDED' },
          { set: { planner: endCurrentRound(s.planner, step.reason) } },
        );
        continue;
      }

      rooms.emit(sessionId, RtEvent.THINKING, { sessionId });
      const question = await generateQuestion(s, step.target, blueprint);
      const questionId = randomUUID();
      const seq = s.lastSeq + 1;
      const planner = recordQuestion(s.planner, step.target, questionId);
      const saved = await inTransaction(undefined, async (tx) => {
        const updated = await InterviewSessionModel.updateOne(
          { _id: s._id, stateVersion: s.stateVersion, state: 'ACTIVE' },
          { $set: { planner, lastSeq: seq }, $inc: { stateVersion: 1 } },
          { session: tx },
        );
        if (updated.modifiedCount !== 1) return null;
        const [turn] = await InterviewTurnModel.create(
          [
            {
              sessionId: s._id,
              userId: s.userId,
              seq,
              questionId,
              roundIdx: step.target.roundIdx,
              roundType: step.target.roundType,
              question: {
                text: question.text,
                competencyKey: step.target.competencyKey,
                competencyName: step.target.competencyName,
                source: step.target.source,
                difficulty: step.target.difficulty,
                objective: step.target.objective,
                expectedEvidence: step.target.expectedEvidence,
                followUpOf: step.target.followUpOf,
                followUpDepth: step.target.followUpDepth,
                probeTopic: step.target.probeTopic,
                promptVersion: question.promptVersion,
                model: question.model,
                coding: question.coding ?? null,
              },
              askedAt: now(),
              language: s.language === 'auto' ? 'en' : s.language,
            },
          ],
          { session: tx },
        );
        return turn!.toObject();
      });
      // The session changed while the question was generated (disconnect, end): re-read and decide again.
      if (!saved) continue;
      rooms.emit(sessionId, RtEvent.QUESTION, liveQuestion(saved));
      onQuestion?.(s, saved);
      return;
    }
    logger.error({ sessionId }, 'interview did not settle after 20 steps');
  }

  async function locked<T>(sessionId: string, fn: () => Promise<T>, waitMs = 10_000) {
    const result = await withLock(redis, `cbi:lock:turn:${sessionId}`, fn, {
      ttlMs: TURN_LOCK_TTL_MS,
      waitMs,
    });
    if (result === LOCK_BUSY)
      throw new LiveError('BUSY', 'The interview is busy. Please try again.');
    return result;
  }

  /** Advances in the background (after start or reconnect); errors are logged. */
  function kick(sessionId: string) {
    void locked(sessionId, () => advance(sessionId), 30_000).catch((err: unknown) =>
      logger.error({ err, sessionId }, 'failed to advance interview'),
    );
  }

  async function templateAndPlan(s: Session): Promise<PlannerState> {
    const template = await InterviewTemplateModel.findById(s.templateId).lean();
    if (!template) throw new Error('template missing');
    const blueprint = await blueprintOf(s);
    return createPlanner(template.content.rounds, blueprint.competencies);
  }

  return {
    snapshot,
    advance,
    kick,

    /** READY or READY_TO_START → ACTIVE, reserving a credit (REST `POST /interviews/:id/start`). */
    async start(userId: string, sessionId: string, ctx?: ClientContext) {
      const s = await load(sessionId, userId);
      if (!s) throw AppError.notFound('Interview not found');
      if (s.state === 'ACTIVE' || s.state === 'ROUND_TRANSITION') return s; // double click
      if (!['READY', 'DEVICE_CHECK', 'CONSENT_REQUIRED', 'READY_TO_START'].includes(s.state)) {
        throw new AppError(409, 'INVALID_STATE', 'This interview cannot be started now.');
      }
      if (!s.blueprintId) throw new AppError(409, 'INVALID_STATE', 'Analyse the interview first.');
      await refuseDuringMaintenance(maintenance);
      // Device check (voice and video) and consents, whatever the mode asks for.
      const readiness = await consent.readiness(s, now());
      if (readiness.blocker) throw new AppError(409, 'INVALID_STATE', readiness.blocker);
      const planner = await templateAndPlan(s);
      if (s.campaignId) {
        const campaign = await CampaignModel.findById(s.campaignId, {
          status: 1,
          window: 1,
        }).lean();
        const at = now();
        if (
          !campaign ||
          campaign.status !== 'ACTIVE' ||
          (campaign.window.endAt && at >= campaign.window.endAt)
        ) {
          throw new AppError(
            409,
            'CAMPAIGN_CLOSED',
            'This interview campaign is not accepting interviews now.',
          );
        }
      }
      // Every verified account gets its welcome credit, however it first reaches this point.
      await grantFreeCredits(userId);
      let started: Session;
      try {
        started = await inTransaction(undefined, async (tx) => {
          let version = s.stateVersion;
          let state = s.state;
          // The pre-start steps (device check, consent) were checked above; walk the machine through them.
          for (let step = 0; state !== 'READY_TO_START' && step < 4; step++) {
            const next: SessionEvent | null =
              state === 'READY'
                ? { type: 'PREPARE' }
                : state === 'DEVICE_CHECK'
                  ? { type: 'DEVICE_CHECK_PASSED' }
                  : state === 'CONSENT_REQUIRED'
                    ? { type: 'CONSENT_ACCEPTED' }
                    : null;
            if (!next) break;
            const moved = await applySessionEvent({
              sessionId: s._id,
              userId,
              event: next,
              expectedVersion: version,
              now: now(),
              session: tx,
            });
            if (!moved.ok)
              throw new AppError(409, 'CONFLICT', 'This interview changed. Refresh and try again.');
            state = moved.session.state;
            version = moved.session.stateVersion;
          }
          if (state !== 'READY_TO_START') {
            throw new AppError(409, 'INVALID_STATE', 'This interview cannot be started now.');
          }
          // A sponsored campaign pays while its budget lasts (claimed atomically, in this transaction).
          const sponsored = s.campaignId
            ? Boolean(
                await CampaignModel.findOneAndUpdate(
                  {
                    _id: s.campaignId,
                    'sponsoredCredits.total': { $exists: true },
                    $expr: { $lt: ['$sponsoredCredits.used', '$sponsoredCredits.total'] },
                  },
                  { $inc: { 'sponsoredCredits.used': 1 } },
                  { session: tx, projection: { _id: 1 } },
                ).lean(),
              )
            : false;
          const result = await applySessionEvent({
            sessionId: s._id,
            userId,
            event: { type: 'START' },
            expectedVersion: version,
            // Recording is decided once, at start: video, allowed by the template, and consented.
            set: { planner, recording: { enabled: readiness.recording }, sponsored },
            now: now(),
            session: tx,
          });
          if (!result.ok)
            throw new AppError(409, 'CONFLICT', 'This interview changed. Refresh and try again.');
          return result.session;
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          throw new AppError(
            402,
            'INSUFFICIENT_CREDITS',
            'You need a credit to start an interview.',
          );
        }
        if ((err as { code?: number }).code === 11000) {
          throw AppError.conflict(
            'You already have an interview in progress. Finish or end it first.',
          );
        }
        throw err;
      }
      await audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'interview.started',
          resourceType: 'interviewSession',
          resourceId: sessionId,
          details: { mode: started.mode, budgetMs: started.clock?.budgetMs ?? null },
        },
        ctx,
      );
      kick(sessionId);
      return started;
    },

    /** The candidate ends the interview early (REST `POST /interviews/:id/end`). */
    async end(userId: string, sessionId: string, ctx?: ClientContext) {
      return locked(sessionId, async () => {
        const s = await load(sessionId, userId);
        if (!s) throw AppError.notFound('Interview not found');
        if (s.state === 'PROCESSING' || s.state === 'COMPLETING') return (await finish(s)) ?? s;
        const ended = await event(s, { type: 'END_REQUESTED' }, { reason: 'ended by candidate' });
        if (!ended.ok)
          throw new AppError(409, 'INVALID_STATE', 'This interview is not in progress.');
        await audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'interview.ended_early',
            resourceType: 'interviewSession',
            resourceId: sessionId,
            details: { answered: ended.session.planner?.answeredCount ?? 0 },
          },
          ctx,
        );
        return (await finish(ended.session)) ?? ended.session;
      });
    },

    /** A candidate's room connects: resume a disconnected or paused interview. */
    async join(userId: string, sessionId: string, lastSeq: number) {
      const s = await load(sessionId, userId).catch(() => null);
      if (!s) throw new LiveError('NOT_FOUND', 'Interview not found');
      if (!JOINABLE.has(s.state))
        throw new LiveError('INVALID_STATE', 'This interview has not started.');
      let current = s;
      const resume: SessionEvent | null =
        s.state === 'RECONNECTING'
          ? { type: 'RECONNECTED' }
          : s.state === 'PAUSED'
            ? { type: 'RESUME' }
            : null;
      if (resume) {
        const r = await locked(sessionId, () => event(s, resume));
        if (r.ok) current = r.session;
      } else if (s.state === 'ACTIVE' || s.state === 'ROUND_TRANSITION') {
        await InterviewSessionModel.updateOne({ _id: s._id }, { $set: { lastSeenAt: now() } });
      }
      if (
        current.state === 'ACTIVE' ||
        current.state === 'ROUND_TRANSITION' ||
        current.state === 'COMPLETING'
      ) {
        kick(sessionId);
      }
      return snapshot(current, lastSeq);
    },

    /** Every socket for the session has gone: pause the clock (RECONNECTING). */
    async disconnected(sessionId: string) {
      await locked(
        sessionId,
        async () => {
          const s = await load(sessionId);
          if (s && (s.state === 'ACTIVE' || s.state === 'ROUND_TRANSITION')) {
            await event(s, { type: 'DISCONNECTED' }, { reason: 'connection lost' });
          }
        },
        15_000,
      );
    },

    /** Keeps the session alive and ends it when the time budget is used up. */
    async heartbeat(userId: string, sessionId: string) {
      const s = await load(sessionId, userId);
      if (!s) throw new LiveError('NOT_FOUND', 'Interview not found');
      if (s.state !== 'ACTIVE' && s.state !== 'ROUND_TRANSITION') return;
      await InterviewSessionModel.updateOne({ _id: s._id }, { $set: { lastSeenAt: now() } });
      if (sessionRemainingMs(s, now()) <= 0) {
        // Only one replica needs to do this; a busy lock means a turn is already moving it on.
        await withLock(redis, `cbi:lock:turn:${sessionId}`, () => advance(sessionId), {
          ttlMs: TURN_LOCK_TTL_MS,
        });
      }
    },

    /** Records an answer, assesses it and moves on. Idempotent per clientMsgId. */
    async answer(
      userId: string,
      payload: AnswerTextPayload,
      opts: { coding?: true } = {},
    ): Promise<{ duplicate: boolean }> {
      return locked(payload.sessionId, async () => {
        const s = await load(payload.sessionId, userId);
        if (!s) throw new LiveError('NOT_FOUND', 'Interview not found');
        const turn = await InterviewTurnModel.findOne({
          sessionId: s._id,
          questionId: payload.questionId,
        }).lean();
        if (turn?.answer) {
          if (turn.answer.clientMsgId === payload.clientMsgId) return { duplicate: true };
          throw new LiveError('STALE_QUESTION', 'This question was already answered.');
        }
        if (s.state !== 'ACTIVE')
          throw new LiveError('INVALID_STATE', 'The interview is not active.');
        if (!turn || turn.seq !== s.lastSeq) {
          throw new LiveError('STALE_QUESTION', 'This is not the current question.');
        }
        // A coding question is answered by submitting code in the editor.
        if (turn.question.coding && !opts.coding) {
          throw new LiveError('INVALID_STATE', 'Submit your solution in the code editor.');
        }
        let text = payload.text.trim();
        let voice: {
          durationSec: number;
          language: string | null;
          confidence: number | null;
          model: string;
        } | null = null;
        if (payload.voiceTranscriptId) {
          // A spoken answer: the server's transcript is the answer, whatever the client sent.
          const t = await transcripts.get(payload.voiceTranscriptId);
          if (
            !t ||
            t.userId !== userId ||
            t.sessionId !== payload.sessionId ||
            t.questionId !== payload.questionId
          ) {
            throw new LiveError(
              'VALIDATION_FAILED',
              'That recording has expired. Please answer again.',
            );
          }
          text = t.text.trim();
          voice = {
            durationSec: t.durationSec,
            language: t.language,
            confidence: t.confidence,
            model: t.model,
          };
        }
        const at = now();
        const saved = await InterviewTurnModel.findOneAndUpdate(
          { _id: turn._id, answer: null },
          {
            $set: {
              answer: {
                text,
                clientMsgId: payload.clientMsgId,
                answeredAt: at,
                durationMs: Math.max(0, at.getTime() - new Date(turn.askedAt).getTime()),
                source: voice ? 'VOICE' : 'TEXT',
                voice,
              },
            },
          },
          { returnDocument: 'after' },
        ).lean();
        if (!saved) throw new LiveError('STALE_QUESTION', 'This question was already answered.');
        await InterviewSessionModel.updateOne({ _id: s._id }, { $set: { lastSeenAt: at } });

        const assessment = await assessAnswer(s, saved, text);
        await InterviewTurnModel.updateOne({ _id: saved._id }, { $set: { turnEval: assessment } });
        // Apply the assessment to the latest plan (a disconnect may have changed the session meanwhile).
        for (let attempt = 0; attempt < 3; attempt++) {
          const fresh = await load(payload.sessionId);
          if (!fresh?.planner || fresh.planner.thread?.lastQuestionId !== saved.questionId) break;
          const planner = recordAssessment(fresh.planner, {
            sufficiency: assessment.sufficiency,
            followUpNeeded: assessment.followUpNeeded,
            followUpAngle: assessment.followUpAngle,
            evidenceCount: assessment.evidence.length,
          });
          const updated = await InterviewSessionModel.updateOne(
            { _id: fresh._id, stateVersion: fresh.stateVersion },
            { $set: { planner }, $inc: { stateVersion: 1 } },
          );
          if (updated.modifiedCount === 1) break;
        }
        await advance(payload.sessionId);
        return { duplicate: false };
      });
    },
  };
}

export type LiveInterviewService = ReturnType<typeof createLiveInterviewService>;
