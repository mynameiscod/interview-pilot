import { renderPrompt, untrusted, type PromptValue } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import {
  applySessionEvent,
  InterviewEvidenceModel,
  InterviewReportModel,
  InterviewScoreModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  InterviewTurnModel,
  JobTargetModel,
  RoleBlueprintModel,
  UserModel,
  type DraftDimensionScore,
  type InterviewSessionRecord,
  type ScoreDimensionRecord,
} from '@cbi/db';
import type { EmailProvider, StorageProvider } from '@cbi/provider-adapters';
import {
  aggregate,
  confidence,
  evidenceStats,
  guardScore,
  readinessBand,
  strengthScore,
} from '@cbi/scoring-core';
import {
  ExtractEvidenceAi,
  ProcessingStage,
  RecommendationsAi,
  ScoreDimensionAi,
  type AiFeature,
  type ReportContent,
} from '@cbi/shared-types';
import type { z } from 'zod';
import { renderReportPdf } from './pdf.js';
import { buildReportContent, fallbackRecommendations } from './report-content.js';

export interface EvaluationDeps {
  ai: AiRuntime;
  storage: StorageProvider;
  email: EmailProvider | null;
  logger: Logger;
  candidateUrl: string;
  now?: () => Date;
}

export const STAGES = ProcessingStage.options;

/** Stages that run after the report exists (the session is REPORT_READY by then). */
const AFTER_REPORT = new Set<ProcessingStage>(['RENDER_PDF', 'NOTIFY']);

export const nextStage = (stage: ProcessingStage): ProcessingStage | null =>
  STAGES[STAGES.indexOf(stage) + 1] ?? null;

/** Live assessment → evidence strength, for the extraction fallback. */
const SUFFICIENCY_STRENGTH = { STRONG: 2, ADEQUATE: 1, WEAK: -1, NO_ANSWER: -2 } as const;

type Session = InterviewSessionRecord;

async function runAi<T>(
  deps: EvaluationDeps,
  feature: AiFeature,
  schema: z.ZodType<T>,
  values: Record<string, PromptValue>,
  s: Session,
): Promise<{ data: T; promptVersion: number } | null> {
  const prompt = await deps.ai.prompts.getActive(feature);
  if (!prompt) {
    deps.logger.error({ feature }, 'no active prompt');
    return null;
  }
  try {
    const result = await deps.ai.router.run<T>(
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
    return { data: result.data, promptVersion: prompt.version };
  } catch (err) {
    deps.logger.warn(
      { err, feature, sessionId: String(s._id) },
      'evaluation ai call failed; using fallback',
    );
    return null;
  }
}

async function context(s: Session) {
  const [blueprint, template, turns] = await Promise.all([
    RoleBlueprintModel.findById(s.blueprintId).lean(),
    InterviewTemplateModel.findById(s.templateId).lean(),
    InterviewTurnModel.find({ sessionId: s._id }).sort({ seq: 1 }).lean(),
  ]);
  if (!blueprint || !template)
    throw new Error('session references a missing blueprint or template');
  return { blueprint: blueprint.content, template: template.content, turns };
}

const bullets = (items: readonly string[]) =>
  items.length ? items.map((x) => `- ${x}`).join('\n') : '-';

// ---- Stages ----------------------------------------------------------------------------------------

/** 1. The transcript is final once the session is PROCESSING; nothing to change, only checked. */
async function finalizeTranscript(_deps: EvaluationDeps, s: Session) {
  const turns = await InterviewTurnModel.countDocuments({ sessionId: s._id });
  if (turns === 0 && s.planner?.askedCount)
    throw new Error('turns missing for a session that asked questions');
}

/** 2. Evidence per round (AI), falling back to the live turn assessments. */
async function extractEvidence(deps: EvaluationDeps, s: Session) {
  const { blueprint, turns } = await context(s);
  const run = s.processing!.run;
  const keys = new Set(blueprint.competencies.map((c) => c.key));
  const competencies = blueprint.competencies
    .map((c) => `${c.key}: ${c.name} - ${c.expectedEvidence.join('; ')}`)
    .join('\n');
  const rounds = [...new Set(turns.map((t) => t.roundIdx))].sort((a, b) => a - b);

  for (const roundIdx of rounds) {
    const answered = turns.filter((t) => t.roundIdx === roundIdx && t.answer?.text.trim());
    // Idempotent per run and round: a retried job replaces its own previous output.
    await InterviewEvidenceModel.deleteMany({ sessionId: s._id, run, roundIdx });
    if (answered.length === 0) continue;
    const questionIds = new Set(answered.map((t) => t.questionId));
    const result = await runAi(
      deps,
      'evaluation.extractEvidence',
      ExtractEvidenceAi,
      {
        roundType: answered[0]!.roundType,
        competencies,
        turns: untrusted(
          answered
            .map(
              (t) =>
                `[${t.questionId}] Competency: ${t.question.competencyKey ?? 'any'}\nQuestion: ${t.question.text}\nAnswer: ${t.answer!.text}`,
            )
            .join('\n\n'),
        ),
      },
      s,
    );
    const extracted = result
      ? result.data.items
          .filter((i) => questionIds.has(i.questionId) && keys.has(i.competencyKey))
          .map((i) => ({ ...i, extractorVersion: result.promptVersion }))
      : [];
    // No usable evidence for answered questions (model unavailable, or it named unknown
    // questions or competencies): fall back to the assessments made during the interview.
    const items = extracted.length
      ? extracted
      : answered
          .filter(
            (t) => t.question.competencyKey && keys.has(t.question.competencyKey) && t.turnEval,
          )
          .map((t) => ({
            questionId: t.questionId,
            competencyKey: t.question.competencyKey!,
            claim:
              t.turnEval!.evidence[0] ??
              `Answer assessed as ${t.turnEval!.sufficiency.toLowerCase().replace('_', ' ')} during the interview.`,
            strength: SUFFICIENCY_STRENGTH[t.turnEval!.sufficiency],
            confidence: 0.5,
            practical: false,
            quote: null,
            uncertainty:
              'Derived from the live assessment because evidence extraction was unavailable.',
            extractorVersion: null,
          }));
    if (items.length) {
      await InterviewEvidenceModel.insertMany(
        items.map((i) => ({ ...i, sessionId: s._id, userId: s.userId, run, roundIdx })),
      );
    }
  }
}

/** 3. One AI score per dimension, from that dimension's evidence and rubric only. */
async function scoreDimensions(deps: EvaluationDeps, s: Session) {
  const { blueprint } = await context(s);
  const evidence = await InterviewEvidenceModel.find({
    sessionId: s._id,
    run: s.processing!.run,
  }).lean();
  const drafts: DraftDimensionScore[] = [];
  for (const c of blueprint.competencies) {
    const items = evidence.filter((e) => e.competencyKey === c.key);
    if (items.length === 0) {
      drafts.push({
        key: c.key,
        aiScore: null,
        rationale: null,
        evidenceIds: [],
        promptVersion: null,
      });
      continue;
    }
    const ids = new Set(items.map((e) => String(e._id)));
    const result = await runAi(
      deps,
      'evaluation.scoreDimension',
      ScoreDimensionAi,
      {
        role: `${blueprint.role.title} (${blueprint.role.seniority.toLowerCase()})`,
        competency: c.name,
        description: c.description,
        expectedEvidence: bullets(c.expectedEvidence),
        evidence: untrusted(
          items
            .map(
              (e) =>
                `${String(e._id)} | ${e.strength} | ${e.practical ? 'practical' : '-'} | ${e.claim}`,
            )
            .join('\n'),
        ),
      },
      s,
    );
    drafts.push({
      key: c.key,
      aiScore: result?.data.score ?? null,
      rationale: result?.data.rationale ?? null,
      evidenceIds: result ? result.data.evidenceIds.filter((id) => ids.has(id)) : [...ids],
      promptVersion: result?.promptVersion ?? null,
    });
  }
  await InterviewSessionModel.updateOne(
    { _id: s._id },
    { $set: { 'processing.draft.dimensions': drafts } },
  );
}

/** 4. Deterministic: guard, aggregate and confidence (scoring-core), stored as score revision 0. */
async function aggregateScores(_deps: EvaluationDeps, s: Session) {
  if (await InterviewScoreModel.exists({ sessionId: s._id, revision: 0 })) return;
  const { blueprint, template } = await context(s);
  const evidence = await InterviewEvidenceModel.find({
    sessionId: s._id,
    run: s.processing!.run,
  }).lean();
  const drafts = new Map((s.processing?.draft.dimensions ?? []).map((d) => [d.key, d]));
  const items = evidence.map((e) => ({
    id: String(e._id),
    questionId: e.questionId,
    competencyKey: e.competencyKey,
    strength: e.strength,
    confidence: e.confidence,
    practical: e.practical,
  }));

  const perDimension = blueprint.competencies.map((c) => {
    const stats = evidenceStats(items.filter((i) => i.competencyKey === c.key));
    const draft = drafts.get(c.key);
    const guarded = guardScore(draft?.aiScore ?? null, stats);
    return { c, stats, draft, guarded };
  });
  const agg = aggregate(
    perDimension.map(({ c, guarded }) => ({
      key: c.key,
      category: c.category,
      weight: c.weight,
      score: guarded.score,
    })),
    template.scoringPolicy.dimensionWeights,
  );
  const scored = perDimension.filter((d) => d.guarded.score !== null);
  const conf = confidence({
    independentQuestions: new Set(items.map((i) => i.questionId)).size,
    practicalEvidence: scored.reduce((n, d) => n + d.stats.practical, 0),
    dimensionStats: scored.map((d) => d.stats),
    scoreGaps: scored
      .filter((d) => d.draft?.aiScore !== null && d.draft?.aiScore !== undefined)
      .map((d) => Math.abs(d.draft!.aiScore! - strengthScore(d.stats.meanStrength!))),
    assessedWeight: agg.assessedWeight,
  });

  const dimensions: ScoreDimensionRecord[] = perDimension.map(({ c, draft, guarded }) => ({
    key: c.key,
    name: c.name,
    category: c.category,
    weight: agg.weightsPercent[c.key]!,
    score: guarded.score,
    aiScore: draft?.aiScore ?? null,
    adjusted: guarded.adjusted,
    fallback: guarded.fallback,
    rationale: draft?.rationale ?? null,
    evidenceIds: draft?.evidenceIds ?? [],
  }));
  const promptVersions: Record<string, number> = {};
  const extractor = evidence.find((e) => e.extractorVersion !== null)?.extractorVersion;
  if (extractor) promptVersions['evaluation.extractEvidence'] = extractor;
  const scorer = [...drafts.values()].find((d) => d.promptVersion !== null)?.promptVersion;
  if (scorer) promptVersions['evaluation.scoreDimension'] = scorer;

  await InterviewScoreModel.create({
    sessionId: s._id,
    userId: s.userId,
    revision: 0,
    dimensions,
    overall: agg.overall,
    band: readinessBand(agg.overall),
    confidence: conf,
    assessedWeight: agg.assessedWeight,
    templateId: s.templateId,
    promptVersions,
    createdBy: 'AI',
    reason: null,
  }).catch((err: { code?: number }) => {
    if (err.code !== 11000) throw err; // a concurrent run already wrote revision 0
  });
}

/** 5. Strengths, gaps and plans (AI), with a deterministic fallback. */
async function recommendations(deps: EvaluationDeps, s: Session) {
  const [{ blueprint }, score] = await Promise.all([
    context(s),
    InterviewScoreModel.findOne({ sessionId: s._id, revision: 0 }).lean(),
  ]);
  if (!score) throw new Error('score revision 0 missing');
  const evidence = await InterviewEvidenceModel.find({ sessionId: s._id, run: s.processing!.run })
    .sort({ strength: -1 })
    .lean();
  const notable = [...evidence.slice(0, 4), ...evidence.slice(-4)].filter(
    (e, i, a) => a.indexOf(e) === i,
  );
  const result = await runAi(
    deps,
    'report.recommendations',
    RecommendationsAi,
    {
      language: 'English',
      role: `${blueprint.role.title} (${blueprint.role.seniority.toLowerCase()})`,
      overall:
        score.overall === null ? 'not enough evidence' : `${score.overall}/100 (${score.band})`,
      confidence: score.confidence.level,
      dimensions: score.dimensions
        .map((d) => `${d.key} | ${d.name} | ${d.score ?? 'not assessed'} | ${d.rationale ?? '-'}`)
        .join('\n'),
      evidence: untrusted(
        notable
          .map((e) => `${e.competencyKey} (${e.strength > 0 ? '+' : ''}${e.strength}): ${e.claim}`)
          .join('\n') || '-',
      ),
      gaps: untrusted(bullets(s.analysis?.gaps ?? [])),
    },
    s,
  );
  const recs = result
    ? { ...result.data, promptVersion: result.promptVersion, fallback: false }
    : { ...fallbackRecommendations(score.dimensions), promptVersion: null, fallback: true };
  await InterviewSessionModel.updateOne(
    { _id: s._id },
    { $set: { 'processing.draft.recommendations': recs } },
  );
}

/** A key that groups attempts at the same role for history and comparison. */
function roleKeyOf(s: Session): string | null {
  if (s.analysis?.matchedRole) return `role:${s.analysis.matchedRole.id}`;
  const title = s.analysis?.detectedRole.title.trim().toLowerCase();
  return title ? `title:${title.replace(/\s+/g, ' ')}` : null;
}

/** 6. Report revision 0, then the session becomes REPORT_READY. */
async function buildReport(deps: EvaluationDeps, s: Session) {
  if (!(await InterviewReportModel.exists({ sessionId: s._id, revision: 0 }))) {
    const [{ template, turns }, score] = await Promise.all([
      context(s),
      InterviewScoreModel.findOne({ sessionId: s._id, revision: 0 }).lean(),
    ]);
    const recs = s.processing?.draft.recommendations;
    if (!score || !recs) throw new Error('score or recommendations missing');
    const evidence = await InterviewEvidenceModel.find({
      sessionId: s._id,
      run: s.processing!.run,
    }).lean();
    const roleKey = roleKeyOf(s);
    const previousReport = roleKey
      ? await InterviewReportModel.findOne({
          userId: s.userId,
          roleKey,
          sessionId: { $ne: s._id },
        })
          .sort({ generatedAt: -1 })
          .lean()
      : null;
    const target = await JobTargetModel.findById(s.jobTargetId, {
      companyName: 1,
      structured: 1,
    }).lean();

    const content: ReportContent = buildReportContent({
      header: {
        title: s.analysis?.detectedRole.title ?? template.name,
        companyName: target?.companyName ?? target?.structured?.companyName ?? null,
        mode: s.mode,
        language: s.language,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        activeMs: s.clock?.activeMs ?? 0,
        endReason: s.endReason,
      },
      rounds: s.planner?.rounds ?? [],
      turns: turns.map((t) => ({
        seq: t.seq,
        questionId: t.questionId,
        roundIdx: t.roundIdx,
        roundType: t.roundType,
        question: t.question.text,
        answer: t.answer?.text ?? null,
      })),
      dimensions: score.dimensions,
      evidence: evidence.map((e) => ({
        id: String(e._id),
        questionId: e.questionId,
        competencyKey: e.competencyKey,
        claim: e.claim,
        strength: e.strength,
        quote: e.quote,
      })),
      overall: {
        score: score.overall,
        band: score.band,
        confidence: score.confidence,
        assessedWeight: score.assessedWeight,
      },
      recommendations: recs,
      skills: s.analysis?.skills ?? [],
      showTranscript: template.reportPolicy.showTranscript,
      previous: previousReport
        ? {
            sessionId: String(previousReport.sessionId),
            overall: previousReport.overall,
            endedAt: previousReport.content.header.endedAt
              ? new Date(previousReport.content.header.endedAt)
              : null,
            dimensions: previousReport.content.dimensions.map((d) => ({
              key: d.key,
              name: d.name,
              score: d.score,
            })),
          }
        : null,
    });
    await InterviewReportModel.create({
      sessionId: s._id,
      userId: s.userId,
      revision: 0,
      scoreRevision: 0,
      content,
      roleKey,
      overall: score.overall,
      generatedAt: deps.now?.() ?? new Date(),
    }).catch((err: { code?: number }) => {
      if (err.code !== 11000) throw err;
    });
  }
  if (s.state === 'PROCESSING') {
    await applySessionEvent({
      sessionId: s._id,
      event: { type: 'EVALUATION_COMPLETED' },
      reason: 'report ready',
    });
  }
}

/** 7. The PDF copy of the report (the report is already visible without it). */
async function renderPdf(deps: EvaluationDeps, s: Session) {
  const report = await InterviewReportModel.findOne({ sessionId: s._id, revision: 0 }).lean();
  if (!report) throw new Error('report missing');
  if (report.pdf.status === 'READY') return;
  const pdf = await renderReportPdf(report.content);
  const key = `reports/${String(s.userId)}/${String(s._id)}/r0.pdf`;
  await deps.storage.put(key, pdf, 'application/pdf');
  await InterviewReportModel.updateOne(
    { _id: report._id },
    {
      $set: { pdf: { status: 'READY', storageKey: key, generatedAt: deps.now?.() ?? new Date() } },
    },
  );
}

/** 8. "Your report is ready" email, when email is configured and the address is verified. */
async function notify(deps: EvaluationDeps, s: Session) {
  if (!deps.email) {
    deps.logger.info({ sessionId: String(s._id) }, 'email disabled; report-ready notice skipped');
    return;
  }
  const user = await UserModel.findById(s.userId, { primaryEmail: 1, emailVerifiedAt: 1 }).lean();
  if (!user?.primaryEmail || !user.emailVerifiedAt) return;
  const link = `${deps.candidateUrl.replace(/\/$/, '')}/app/reports/${String(s._id)}`;
  await deps.email.send({
    to: user.primaryEmail,
    subject: 'Your interview readiness report is ready',
    text: `Your practice interview has been evaluated.\n\nOpen your report: ${link}\n\nIt includes your readiness by area, the evidence behind it and a 7-day practice plan.\n\nCareerPilot Interview by CodeBegun`,
  });
}

const HANDLERS: Record<ProcessingStage, (deps: EvaluationDeps, s: Session) => Promise<void>> = {
  FINALIZE_TRANSCRIPT: finalizeTranscript,
  EXTRACT_EVIDENCE: extractEvidence,
  SCORE_DIMENSIONS: scoreDimensions,
  AGGREGATE: aggregateScores,
  RECOMMENDATIONS: recommendations,
  BUILD_REPORT: buildReport,
  RENDER_PDF: renderPdf,
  NOTIFY: notify,
};

export type StageOutcome = { status: 'done'; next: ProcessingStage | null } | { status: 'skipped' };

/**
 * Runs one stage for one pipeline run. Idempotent: a stage already
 * completed in this run, a stale run, or a session in the wrong state is
 * skipped. Progress is recorded on the session; on the final failed attempt
 * the stage is marked FAILED (the transcript and earlier results are kept).
 */
export async function runEvaluationStage(
  deps: EvaluationDeps,
  job: { sessionId: string; stage: ProcessingStage; run: number },
  finalAttempt: boolean,
): Promise<StageOutcome> {
  const now = () => deps.now?.() ?? new Date();
  const s = await InterviewSessionModel.findById(job.sessionId).lean<Session>();
  const expectedState = AFTER_REPORT.has(job.stage) ? 'REPORT_READY' : 'PROCESSING';
  if (!s || !s.processing || s.processing.run !== job.run) return { status: 'skipped' };
  if (s.processing.completed.includes(job.stage))
    return { status: 'done', next: nextStage(job.stage) };
  // BUILD_REPORT may be retried after its state change already happened.
  if (s.state !== expectedState && !(job.stage === 'BUILD_REPORT' && s.state === 'REPORT_READY')) {
    return { status: 'skipped' };
  }

  await InterviewSessionModel.updateOne(
    { _id: s._id, 'processing.run': job.run },
    {
      $set: {
        'processing.stage': job.stage,
        'processing.status': 'RUNNING',
        'processing.updatedAt': now(),
      },
      $inc: { 'processing.attempts': 1 },
    },
  );
  try {
    await HANDLERS[job.stage](deps, s);
  } catch (err) {
    deps.logger.error(
      { err, sessionId: job.sessionId, stage: job.stage },
      'evaluation stage failed',
    );
    await InterviewSessionModel.updateOne(
      { _id: s._id, 'processing.run': job.run },
      {
        $set: {
          'processing.status': finalAttempt ? 'FAILED' : 'QUEUED',
          'processing.error': finalAttempt ? `${job.stage} failed` : null,
          'processing.updatedAt': now(),
        },
      },
    );
    throw err;
  }
  const next = nextStage(job.stage);
  await InterviewSessionModel.updateOne(
    { _id: s._id, 'processing.run': job.run },
    {
      $addToSet: { 'processing.completed': job.stage },
      $set: {
        'processing.stage': next,
        'processing.status': next ? 'QUEUED' : 'DONE',
        'processing.error': null,
        'processing.attempts': 0,
        'processing.updatedAt': now(),
      },
    },
  );
  return { status: 'done', next };
}
