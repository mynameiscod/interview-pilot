import { buildAiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import {
  AiRouteModel,
  beginEvaluation,
  connectMongo,
  createRedis,
  disconnectMongo,
  ensureAiCatalog,
  ensureIndexes,
  ensureLibraryCatalog,
  InterviewEvidenceModel,
  InterviewReportModel,
  InterviewScoreModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  InterviewTurnModel,
  JobTargetModel,
  mongoose,
  RoleBlueprintModel,
  RoleModel,
  UserModel,
} from '@cbi/db';
import { competenciesForRound, createPlanner } from '@cbi/interview-engine';
import { createMemoryStorage, createRecordingEmailProvider } from '@cbi/provider-adapters/testing';
import { ReportContent, type ProcessingStage } from '@cbi/shared-types';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nextStage, runEvaluationStage, STAGES, type EvaluationDeps } from './pipeline.js';
import { sweepEvaluations } from './sweep.js';

const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;
if (
  !MONGODB_URI ||
  !REDIS_URL ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need REDIS_URL and a MONGODB_URI whose database name contains "test".',
  );
}

const logger = createLogger({ service: 'test', level: 'silent' });
const redisUrl = new URL(REDIS_URL);
redisUrl.pathname = '/15';
const redis = createRedis(redisUrl.toString(), logger);
const queueRedis = createRedis(redisUrl.toString(), logger, 'queue');
const ai = buildAiRuntime({
  env: {
    APP_ENV: 'test',
    AI_MOCK_MODE: true,
    AI_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    AI_SECRETS_KEY_ID: 'k1',
    AI_CONFIG_CACHE_TTL_SEC: 1,
  },
  logger,
  redis,
});
const { storage, objects } = createMemoryStorage();
const mail = createRecordingEmailProvider();
const deps: EvaluationDeps = {
  ai,
  storage,
  email: mail.provider,
  logger,
  candidateUrl: 'https://interview.example.com',
};

beforeAll(async () => {
  await connectMongo({ uri: MONGODB_URI, autoIndex: false, logger });
  await ensureIndexes();
  await Promise.all([redis.connect(), queueRedis.connect()]);
});
beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray()) {
    await db.collection(name).deleteMany({});
  }
  await redis.flushdb();
  objects.clear();
  mail.sent.length = 0;
  await ensureAiCatalog({ mockMode: true });
  await ensureLibraryCatalog();
  ai.invalidateLocal();
});
afterAll(async () => {
  await disconnectMongo();
  await Promise.all([redis.quit(), queueRedis.quit()]);
});

/** A finished interview in PROCESSING: every round asked and answered, assessed as `sufficiency`. */
async function finishedInterview(
  opts: { userId?: mongoose.Types.ObjectId; sufficiency?: 'STRONG' | 'WEAK'; endedAt?: Date } = {},
) {
  const userId = opts.userId ?? new mongoose.Types.ObjectId();
  if (!opts.userId) {
    await UserModel.create({
      _id: userId,
      primaryEmail: `c-${String(userId)}@example.com`,
      emailVerifiedAt: new Date(),
    });
  }
  const template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
  const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
  const blueprint = await RoleBlueprintModel.findById(role!.activeBlueprintId).lean();
  const target = await JobTargetModel.create({
    userId,
    source: 'ROLE_ONLY',
    roleId: role!._id,
    roleTitle: role!.title,
    companyName: 'Acme',
    extraction: { status: 'READY' },
  });
  const planner = createPlanner(template!.content.rounds, blueprint!.content.competencies);
  planner.rounds = planner.rounds.map((r) => ({ ...r, state: 'COMPLETED' as const }));
  planner.roundIdx = planner.rounds.length - 1;
  planner.answeredCount = 10;
  const session = await InterviewSessionModel.create({
    userId,
    jobTargetId: target._id,
    templateId: template!._id,
    blueprintId: blueprint!._id,
    state: 'PROCESSING',
    planner,
    clock: { budgetMs: 1_920_000, activeMs: 1_500_000, runningSince: null },
    startedAt: new Date('2026-09-24T10:00:00Z'),
    endedAt: opts.endedAt ?? new Date('2026-09-24T10:25:00Z'),
    endReason: 'ROUND_ENDED',
    analysis: {
      detectedRole: {
        title: 'Backend Engineer',
        family: 'ENGINEERING',
        seniority: 'MID',
        confidence: 0.9,
      },
      matchedRole: { id: String(role!._id), title: role!.title },
      blueprint: { id: String(blueprint!._id), origin: 'CANONICAL', version: 1 },
      skills: [
        { name: 'API design', weight: 40, sources: ['ROLE'], inResume: true },
        { name: 'Kubernetes', weight: 20, sources: ['JD'], inResume: false },
      ],
      resumeHighlights: [],
      gaps: ['No Kubernetes experience shown'],
      inputs: { resume: true, jd: false, companyPatterns: false },
      plannedRounds: [],
      totalDurationSec: 1920,
      analyzedAt: new Date().toISOString(),
    },
    credit: { status: 'CONSUMED', lotId: null },
  });
  let seq = 0;
  const turns = template!.content.rounds.flatMap((round, roundIdx) => {
    const competencies = competenciesForRound(round.type, blueprint!.content.competencies);
    return [0, 1].map((i) => {
      const c = competencies[i % Math.max(1, competencies.length)] ?? null;
      seq += 1;
      return {
        sessionId: session._id,
        userId,
        seq,
        questionId: `q-${String(session._id)}-${seq}`,
        roundIdx,
        roundType: round.type,
        question: {
          text: `Question ${seq} about ${c?.name ?? 'yourself'}?`,
          competencyKey: c?.key ?? null,
          competencyName: c?.name ?? null,
          source: 'ROLE',
          difficulty: 'MEDIUM',
          objective: 'Assess',
          expectedEvidence: c?.expectedEvidence ?? [],
          followUpOf: null,
          followUpDepth: 0,
          probeTopic: null,
          promptVersion: 1,
          model: 'mock-llm',
        },
        askedAt: new Date(),
        answer: {
          text: `A specific answer ${seq} with a concrete example and result.`,
          clientMsgId: `m-${seq}`,
          answeredAt: new Date(),
          durationMs: 30_000,
        },
        turnEval: {
          sufficiency: opts.sufficiency ?? 'STRONG',
          followUpNeeded: false,
          followUpAngle: null,
          evidence: [`Described a concrete example for question ${seq}`],
          notes: null,
          promptVersion: 1,
          model: 'mock-llm',
          fallback: false,
        },
        language: 'en',
      };
    });
  });
  await InterviewTurnModel.insertMany(turns);
  return { id: String(session._id), userId };
}

async function runAll(
  sessionId: string,
  run: number,
  from: ProcessingStage = 'FINALIZE_TRANSCRIPT',
) {
  let stage: ProcessingStage | null = from;
  const seen: ProcessingStage[] = [];
  while (stage) {
    const outcome = await runEvaluationStage(deps, { sessionId, stage, run }, false);
    seen.push(stage);
    stage = outcome.status === 'done' ? outcome.next : null;
  }
  return seen;
}

describe('evaluation pipeline', () => {
  it('runs every stage to a report, PDF and email', async () => {
    const { id, userId } = await finishedInterview();
    const run = await beginEvaluation(id);
    expect(run).toBe(1);
    expect(await beginEvaluation(id)).toBeNull(); // starts once
    expect(await runAll(id, 1)).toEqual([...STAGES]);

    const session = await InterviewSessionModel.findById(id).lean();
    expect(session).toMatchObject({
      state: 'REPORT_READY',
      processing: { status: 'DONE', stage: null },
    });
    expect(session!.processing!.completed).toEqual([...STAGES]);

    const score = await InterviewScoreModel.findOne({ sessionId: id, revision: 0 }).lean();
    expect(score).toMatchObject({ createdBy: 'AI', revision: 0 });
    expect(score!.dimensions.length).toBe(7);
    expect(score!.overall).not.toBeNull();
    // STRONG live assessments back every scored dimension, so scores sit in the top band.
    expect(score!.dimensions.filter((d) => d.score !== null).every((d) => d.score! >= 75)).toBe(
      true,
    );

    const report = await InterviewReportModel.findOne({ sessionId: id, revision: 0 }).lean();
    const content = ReportContent.parse(report!.content);
    expect(content.header).toMatchObject({
      title: 'Backend Engineer',
      companyName: 'Acme',
      durationSec: 1500,
    });
    expect(content.rounds.map((r) => r.answered)).toEqual([2, 2, 2, 2, 2]);
    expect(content.transcript).toHaveLength(10);
    expect(content.coverage.find((c) => c.skill === 'API design')!.assessed).toBe(true);
    expect(content.plan.next24h.length).toBeGreaterThan(0);
    expect(content.previous).toBeNull();
    expect(report!.pdf.status).toBe('READY');
    const pdf = objects.get(report!.pdf.storageKey!)!;
    expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: `c-${String(userId)}@example.com` });
    expect(mail.sent[0]!.text).toContain(`https://interview.example.com/app/reports/${id}`);
  });

  it('is idempotent: re-running stages changes nothing and stale runs are ignored', async () => {
    const { id } = await finishedInterview();
    await beginEvaluation(id);
    await runAll(id, 1);
    const evidence = await InterviewEvidenceModel.countDocuments({ sessionId: id });
    // A duplicate delivery of an early stage after the report exists is skipped.
    expect(
      await runEvaluationStage(deps, { sessionId: id, stage: 'AGGREGATE', run: 1 }, false),
    ).toEqual({
      status: 'done',
      next: 'RECOMMENDATIONS',
    });
    expect(
      await runEvaluationStage(deps, { sessionId: id, stage: 'NOTIFY', run: 2 }, false),
    ).toEqual({ status: 'skipped' });
    expect(await InterviewEvidenceModel.countDocuments({ sessionId: id })).toBe(evidence);
    expect(await InterviewScoreModel.countDocuments({ sessionId: id })).toBe(1);
    expect(await InterviewReportModel.countDocuments({ sessionId: id })).toBe(1);
    expect(mail.sent).toHaveLength(1);
  });

  it('still produces a report when every AI feature is unavailable', async () => {
    await AiRouteModel.updateMany({}, { $set: { active: false } });
    ai.invalidateLocal();
    const { id } = await finishedInterview({ sufficiency: 'WEAK' });
    await beginEvaluation(id);
    await runAll(id, 1);
    const score = await InterviewScoreModel.findOne({ sessionId: id }).lean();
    const scored = score!.dimensions.filter((d) => d.score !== null);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.every((d) => d.fallback && d.aiScore === null)).toBe(true);
    // WEAK live assessments map to strength -1, i.e. 25/100.
    expect(scored.every((d) => d.score === 25)).toBe(true);
    const evidence = await InterviewEvidenceModel.find({ sessionId: id }).lean();
    expect(evidence.every((e) => e.extractorVersion === null)).toBe(true);
    const report = await InterviewReportModel.findOne({ sessionId: id }).lean();
    expect(report!.content.overall.band).toBe('NOT_YET');
    expect(report!.content.plan.next24h.length).toBeGreaterThan(0);
    expect((await InterviewSessionModel.findById(id).lean())!.state).toBe('REPORT_READY');
  });

  it('compares with the previous attempt at the same role', async () => {
    const first = await finishedInterview({
      sufficiency: 'WEAK',
      endedAt: new Date('2026-09-20T10:00:00Z'),
    });
    await beginEvaluation(first.id);
    await runAll(first.id, 1);
    const second = await finishedInterview({ userId: first.userId, sufficiency: 'WEAK' });
    await beginEvaluation(second.id);
    await runAll(second.id, 1);
    const report = await InterviewReportModel.findOne({ sessionId: second.id }).lean();
    expect(report!.roleKey).toMatch(/^role:/);
    expect(report!.content.previous).toMatchObject({ sessionId: first.id });
    expect(report!.content.previous!.deltas.length).toBeGreaterThan(0);
  });

  it('records a failed stage without losing earlier work', async () => {
    const other = await finishedInterview();
    await beginEvaluation(other.id);
    for (const stage of ['FINALIZE_TRANSCRIPT', 'EXTRACT_EVIDENCE', 'SCORE_DIMENSIONS'] as const) {
      await runEvaluationStage(deps, { sessionId: other.id, stage, run: 1 }, false);
    }
    // Pretend AGGREGATE completed but its score revision was lost, so RECOMMENDATIONS cannot run.
    await InterviewSessionModel.updateOne(
      { _id: other.id },
      {
        $set: {
          'processing.completed': [
            'FINALIZE_TRANSCRIPT',
            'EXTRACT_EVIDENCE',
            'SCORE_DIMENSIONS',
            'AGGREGATE',
          ],
        },
      },
    );
    await expect(
      runEvaluationStage(deps, { sessionId: other.id, stage: 'RECOMMENDATIONS', run: 1 }, true),
    ).rejects.toThrow(/score revision 0 missing/);
    const failed = await InterviewSessionModel.findById(other.id).lean();
    expect(failed).toMatchObject({
      state: 'PROCESSING',
      processing: { status: 'FAILED', stage: 'RECOMMENDATIONS' },
    });
    expect(await InterviewTurnModel.countDocuments({ sessionId: other.id })).toBe(10);
    expect(await InterviewEvidenceModel.countDocuments({ sessionId: other.id })).toBeGreaterThan(0);
    // An admin re-run starts a fresh run from the first stage.
    expect(await beginEvaluation(other.id, { rerun: true })).toBe(2);
    await runAll(other.id, 2);
    expect((await InterviewSessionModel.findById(other.id).lean())!.state).toBe('REPORT_READY');
  });

  it('lists the stages in order', () => {
    expect(nextStage('BUILD_REPORT')).toBe('RENDER_PDF');
    expect(nextStage('NOTIFY')).toBeNull();
  });
});

describe('sweepEvaluations', () => {
  it('starts evaluations that were never enqueued and re-queues stalled stages', async () => {
    const queue = new Queue('evaluation', { connection: queueRedis });
    try {
      const { id } = await finishedInterview();
      await InterviewSessionModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { updatedAt: new Date(Date.now() - 60_000) } },
      );
      expect(await sweepEvaluations({ queue })).toEqual({ started: 1, resumed: 0 });
      expect(await queue.getJob(`evaluation-${id}-FINALIZE_TRANSCRIPT-1`)).toBeTruthy();
      expect(await sweepEvaluations({ queue })).toEqual({ started: 0, resumed: 0 });
      await InterviewSessionModel.updateOne(
        { _id: id },
        { $set: { 'processing.updatedAt': new Date(Date.now() - 11 * 60_000) } },
      );
      expect((await sweepEvaluations({ queue })).resumed).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
