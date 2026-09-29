import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import {
  CampaignModel,
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
  IntegrityEventModel,
} from '@cbi/db';
import { drillBlueprint } from '@cbi/interview-engine';
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
  ProcessingStage,
  type BlueprintContent,
  type ReportContent,
  summarizeIntegrity,
} from '@cbi/shared-types';
import {
  bullets,
  extractEvidenceWithAi,
  questionFeedbackWithAi,
  recommendationsWithAi,
  scoreDimensionWithAi,
} from './ai-steps.js';
import { peerBenchmark, roleFamilyKey } from './benchmark.js';
import { mapWithConcurrency } from './concurrency.js';
import { outputLanguage, type OutputLanguage } from './language.js';
import { reportReadyEmail, submittedEmail } from './notify-messages.js';
import { renderReportPdf } from './pdf.js';
import { COACHING_CONCURRENCY, coachingKey, questionFeedback } from './question-feedback.js';
import { buildReportContent, fallbackRecommendations } from './report-content.js';
import { isBehavioural } from './star.js';
import type { JudgeAdapter } from '@cbi/provider-adapters';
import {
  answeredWithCode,
  codingReport,
  judgeUnsubmitted,
  loadCoding,
  mergeCodingEvidence,
} from './coding.js';

export interface EvaluationDeps {
  ai: AiRuntime;
  storage: StorageProvider;
  email: EmailProvider | null;
  /** Live check (admin-managed integrations); default: whether `email` is set. */
  emailEnabled?: () => boolean;
  logger: Logger;
  candidateUrl: string;
  /** Code judge for solutions left unsubmitted (null: they are recorded as not run). */
  judge?: JudgeAdapter | null;
  now?: () => Date;
}

export const STAGES = ProcessingStage.options;

/** Stages that run after the report exists (the session is REPORT_READY by then). */
const AFTER_REPORT = new Set<ProcessingStage>(['RENDER_PDF', 'NOTIFY']);

export const nextStage = (stage: ProcessingStage): ProcessingStage | null =>
  STAGES[STAGES.indexOf(stage) + 1] ?? null;

/**
 * Live assessment → evidence strength, for the extraction fallback. An
 * UNASSESSED answer (the live assessment could not run) carries no verdict,
 * so it yields no evidence either way.
 */
const SUFFICIENCY_STRENGTH = { STRONG: 2, ADEQUATE: 1, WEAK: -1, NO_ANSWER: -2 } as const;

type Session = InterviewSessionRecord;

const isDrill = (s: Session) => s.kind === 'DRILL' && s.drill !== null;

/**
 * The session's blueprint, template and turns. A drill is evaluated on its
 * one competency only, so its overall score is that dimension's score.
 */
async function context(s: Session) {
  const [blueprint, template, turns] = await Promise.all([
    RoleBlueprintModel.findById(s.blueprintId).lean(),
    InterviewTemplateModel.findById(s.templateId).lean(),
    InterviewTurnModel.find({ sessionId: s._id }).sort({ seq: 1 }).lean(),
  ]);
  if (!blueprint || !template)
    throw new Error('session references a missing blueprint or template');
  const content = isDrill(s)
    ? drillBlueprint(blueprint.content, s.drill!.competencyKey)
    : blueprint.content;
  return { blueprint: content, template: template.content, turns };
}

const answerTexts = (turns: readonly { answer?: { text: string } | null }[]) =>
  turns.map((t) => t.answer?.text ?? '');

const ctxOf = (s: Session) => ({ userId: String(s.userId), sessionId: String(s._id) });
const roleOf = (b: BlueprintContent) => `${b.role.title} (${b.role.seniority.toLowerCase()})`;

// ---- Stages ----------------------------------------------------------------------------------------

/** 1. The transcript is final once the session is PROCESSING; nothing to change, only checked. */
async function finalizeTranscript(deps: EvaluationDeps, s: Session) {
  const turns = await InterviewTurnModel.countDocuments({ sessionId: s._id });
  if (turns === 0 && s.planner?.askedCount)
    throw new Error('turns missing for a session that asked questions');
  // Code written but not submitted before the end is judged now (never fails the stage).
  await judgeUnsubmitted(s._id, deps.judge ?? null, deps.logger, deps.now?.() ?? new Date());
}

/** 2. Evidence per round (AI), falling back to the live turn assessments. */
async function extractEvidence(deps: EvaluationDeps, s: Session) {
  const { blueprint, turns } = await context(s);
  const run = s.processing!.run;
  const keys = new Set(blueprint.competencies.map((c) => c.key));
  const rounds = [...new Set(turns.map((t) => t.roundIdx))].sort((a, b) => a - b);
  const coding = await loadCoding(s._id);

  for (const roundIdx of rounds) {
    const roundTurns = turns.filter((t) => t.roundIdx === roundIdx);
    const answered = answeredWithCode(roundTurns, coding);
    // Idempotent per run and round: a retried job replaces its own previous output.
    await InterviewEvidenceModel.deleteMany({ sessionId: s._id, run, roundIdx });
    if (answered.length === 0) continue;
    const result = await extractEvidenceWithAi(
      deps,
      {
        roundType: answered[0]!.turn.roundType,
        competencies: blueprint.competencies,
        turns: answered.map(({ turn: t, text, spoken }) => ({
          questionId: t.questionId,
          competencyKey: t.question.competencyKey,
          question: t.question.text,
          answer: text,
          spoken,
        })),
      },
      ctxOf(s),
    );
    const extracted = result
      ? result.items.map((i) => ({ ...i, extractorVersion: result.promptVersion }))
      : [];
    // No usable evidence for answered questions (model unavailable, or it named unknown
    // questions or competencies): fall back to the assessments made during the interview.
    const items = extracted.length
      ? extracted
      : answered
          .map((a) => a.turn)
          .filter(
            (t) =>
              t.question.competencyKey &&
              keys.has(t.question.competencyKey) &&
              t.turnEval &&
              t.turnEval.sufficiency !== 'UNASSESSED',
          )
          .map((t) => ({
            questionId: t.questionId,
            competencyKey: t.question.competencyKey!,
            claim:
              t.turnEval!.evidence[0] ??
              `Answer assessed as ${t.turnEval!.sufficiency.toLowerCase().replace('_', ' ')} during the interview.`,
            strength:
              SUFFICIENCY_STRENGTH[t.turnEval!.sufficiency as keyof typeof SUFFICIENCY_STRENGTH],
            confidence: 0.5,
            practical: false,
            quote: null,
            uncertainty:
              'Derived from the live assessment because evidence extraction was unavailable.',
            extractorVersion: null,
          }));
    // Judge results are deterministic evidence; code the judge could not run is less certain.
    const merged = mergeCodingEvidence(items, roundTurns, coding, blueprint);
    if (merged.length) {
      await InterviewEvidenceModel.insertMany(
        merged.map((i) => ({ ...i, sessionId: s._id, userId: s.userId, run, roundIdx })),
      );
    }
  }
}

/** Dimensions scored at the same time (each is an independent AI call). */
export const SCORING_CONCURRENCY = 3;

/** 3. One AI score per dimension, from that dimension's evidence and rubric only. */
async function scoreDimensions(deps: EvaluationDeps, s: Session) {
  const { blueprint } = await context(s);
  const evidence = await InterviewEvidenceModel.find({
    sessionId: s._id,
    run: s.processing!.run,
  }).lean();
  const drafts = await mapWithConcurrency(
    blueprint.competencies,
    SCORING_CONCURRENCY,
    async (c): Promise<DraftDimensionScore> => {
      const items = evidence
        .filter((e) => e.competencyKey === c.key)
        .map((e) => ({
          id: String(e._id),
          strength: e.strength,
          practical: e.practical,
          claim: e.claim,
        }));
      if (items.length === 0) {
        return { key: c.key, aiScore: null, rationale: null, evidenceIds: [], promptVersion: null };
      }
      const result = await scoreDimensionWithAi(
        deps,
        { role: roleOf(blueprint), competency: c, evidence: items },
        ctxOf(s),
      );
      return {
        key: c.key,
        aiScore: result?.score ?? null,
        rationale: result?.rationale ?? null,
        evidenceIds: result ? result.evidenceIds : items.map((i) => i.id),
        promptVersion: result?.promptVersion ?? null,
      };
    },
  );
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
  const [{ blueprint, turns }, score] = await Promise.all([
    context(s),
    InterviewScoreModel.findOne({ sessionId: s._id, revision: 0 }).lean(),
  ]);
  if (!score) throw new Error('score revision 0 missing');
  if (isDrill(s)) {
    // A drill's evaluation is quick: its feedback is the evidence per question, not a plan.
    await InterviewSessionModel.updateOne(
      { _id: s._id },
      {
        $set: {
          'processing.draft.recommendations': {
            ...fallbackRecommendations(score.dimensions),
            promptVersion: null,
            fallback: true,
          },
        },
      },
    );
    return;
  }
  const language = outputLanguage(s.language, answerTexts(turns));
  const evidence = await InterviewEvidenceModel.find({ sessionId: s._id, run: s.processing!.run })
    .sort({ strength: -1 })
    .lean();
  const notable = [...evidence.slice(0, 4), ...evidence.slice(-4)].filter(
    (e, i, a) => a.indexOf(e) === i,
  );
  const result = await recommendationsWithAi(
    deps,
    {
      language,
      role: roleOf(blueprint),
      overall:
        score.overall === null ? 'not enough evidence' : `${score.overall}/100 (${score.band})`,
      confidence: score.confidence.level,
      dimensions: score.dimensions
        .map((d) => `${d.key} | ${d.name} | ${d.score ?? 'not assessed'} | ${d.rationale ?? '-'}`)
        .join('\n'),
      evidence: notable
        .map((e) => `${e.competencyKey} (${e.strength > 0 ? '+' : ''}${e.strength}): ${e.claim}`)
        .join('\n'),
      gaps: bullets(s.analysis?.gaps ?? []),
    },
    ctxOf(s),
  );
  const recs = result
    ? { ...result.data, promptVersion: result.promptVersion, fallback: false }
    : { ...fallbackRecommendations(score.dimensions), promptVersion: null, fallback: true };
  await InterviewSessionModel.updateOne(
    { _id: s._id },
    { $set: { 'processing.draft.recommendations': recs } },
  );
}

type TurnRow = Awaited<ReturnType<typeof context>>['turns'][number];

/** Turns that get a coaching card: answered in words (coding answers have their own section). */
const coachable = (turns: readonly TurnRow[]) =>
  turns.filter((t) => !t.question.coding && Boolean(t.answer?.text.trim()));

/**
 * 5b. Per-question coaching (AI): verdict, what worked, what was missing, an
 * example answer from the candidate's own content and STAR for behavioural
 * questions. Cached on each turn, so a retry or re-run only asks for what is
 * missing. Coaching only: nothing here feeds a score. Answers the model could
 * not coach get a deterministic card when the report is built.
 */
async function coachAnswers(deps: EvaluationDeps, s: Session) {
  const { blueprint, turns } = await context(s);
  const language = outputLanguage(s.language, answerTexts(turns));
  const categories = new Map(blueprint.competencies.map((c) => [c.key, c.category]));
  const evidence = await InterviewEvidenceModel.find(
    { sessionId: s._id, run: s.processing!.run },
    { questionId: 1, claim: 1, strength: 1 },
  ).lean();
  await mapWithConcurrency(coachable(turns), COACHING_CONCURRENCY, async (t) => {
    const answer = t.answer!.text;
    const key = coachingKey(language, t.question.text, answer);
    if (t.coaching?.key === key && t.coaching.feedback) return;
    const result = await questionFeedbackWithAi(
      deps,
      {
        language,
        role: roleOf(blueprint),
        roundType: t.roundType,
        behavioural: isBehavioural(t.roundType, categories.get(t.question.competencyKey ?? '')),
        competency: t.question.competencyName,
        expectedEvidence: t.question.expectedEvidence,
        question: t.question.text,
        answer,
        spoken: t.answer!.source === 'VOICE',
        evidence: evidence.filter((e) => e.questionId === t.questionId),
      },
      ctxOf(s),
    );
    if (!result) return;
    await InterviewTurnModel.updateOne(
      { _id: t._id },
      {
        $set: {
          coaching: {
            key,
            language,
            feedback: result.data,
            promptVersion: result.promptVersion,
            at: deps.now?.() ?? new Date(),
          },
        },
      },
    );
  });
}

/** Report cards for every coached turn, from the cached feedback or the deterministic fallback. */
function coachingCards(
  turns: readonly TurnRow[],
  blueprint: BlueprintContent,
  language: OutputLanguage,
  showAnswer: boolean,
) {
  const categories = new Map(blueprint.competencies.map((c) => [c.key, c.category]));
  return coachable(turns).map((t) => {
    const answer = t.answer!.text;
    const cached =
      t.coaching?.key === coachingKey(language, t.question.text, answer)
        ? (t.coaching.feedback ?? null)
        : null;
    return questionFeedback(
      {
        seq: t.seq,
        questionId: t.questionId,
        roundType: t.roundType,
        question: t.question,
        answer,
        spoken: t.answer!.source === 'VOICE',
        turnEval: t.turnEval,
      },
      cached,
      {
        behavioural: isBehavioural(t.roundType, categories.get(t.question.competencyKey ?? '')),
        showAnswer,
      },
    );
  });
}

/** A key that groups attempts at the same role for history and comparison. */
function roleKeyOf(s: Session): string | null {
  if (s.analysis?.matchedRole) return `role:${s.analysis.matchedRole.id}`;
  const title = s.analysis?.detectedRole.title.trim().toLowerCase();
  return title ? `title:${title.replace(/\s+/g, ' ')}` : null;
}

async function candidateSeesReport(s: Session) {
  if (!s.campaignId) return true;
  const campaign = await CampaignModel.findById(s.campaignId, { candidateSeesReport: 1 }).lean();
  return campaign?.candidateSeesReport ?? false;
}

/** 6. Report revision 0, then the session becomes REPORT_READY. */
async function buildReport(deps: EvaluationDeps, s: Session) {
  if (!(await InterviewReportModel.exists({ sessionId: s._id, revision: 0 }))) {
    const [{ template, turns, blueprint }, score] = await Promise.all([
      context(s),
      InterviewScoreModel.findOne({ sessionId: s._id, revision: 0 }).lean(),
    ]);
    const recs = s.processing?.draft.recommendations;
    if (!score || !recs) throw new Error('score or recommendations missing');
    const evidence = await InterviewEvidenceModel.find({
      sessionId: s._id,
      run: s.processing!.run,
    }).lean();
    // A drill copies its source interview's analysis, so it groups with the same role.
    const roleKey = roleKeyOf(s);
    // "Since your last attempt" compares interviews; drills have their own previous score.
    const previousReport =
      roleKey && !isDrill(s)
        ? await InterviewReportModel.findOne({
            userId: s.userId,
            roleKey,
            kind: { $ne: 'DRILL' },
            sessionId: { $ne: s._id },
          })
            .sort({ generatedAt: -1 })
            .lean()
        : null;
    const target = await JobTargetModel.findById(s.jobTargetId, {
      companyName: 1,
      structured: 1,
    }).lean();

    // Observations are summarised only when the candidate acknowledged tracking; they are never scored.
    const tracked = (s.consents ?? []).some((c) => c.type === 'INTEGRITY' && c.accepted);
    const integrity = tracked
      ? summarizeIntegrity(
          await IntegrityEventModel.find({ sessionId: s._id }, { type: 1, at: 1, value: 1 })
            .sort({ at: 1 })
            .lean(),
          s.startedAt,
        )
      : null;

    const codingItems = codingReport(await loadCoding(s._id), turns);
    const now = deps.now?.() ?? new Date();
    const family = s.analysis?.detectedRole.family ?? null;
    const benchmark = await peerBenchmark({
      overall: score.overall,
      userId: s.userId,
      roleKey,
      roleTitle: s.analysis?.matchedRole?.title ?? s.analysis?.detectedRole.title ?? template.name,
      family,
      now,
    });

    const content: ReportContent = buildReportContent({
      integrity,
      coding: codingItems,
      questions: coachingCards(
        turns,
        blueprint,
        outputLanguage(s.language, answerTexts(turns)),
        template.reportPolicy.showTranscript,
      ),
      delivery: turns.flatMap((t) =>
        t.answer?.source === 'VOICE' && t.answer.voice?.delivery
          ? [{ questionId: t.questionId, seq: t.seq, metrics: t.answer.voice.delivery }]
          : [],
      ),
      benchmark,
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
      kind: isDrill(s) ? 'DRILL' : 'INTERVIEW',
      content,
      // A campaign decides whether its candidates see their own report.
      visibility: { candidate: await candidateSeesReport(s) },
      roleKey,
      roleFamily: family ? roleFamilyKey(family) : null,
      overall: score.overall,
      generatedAt: now,
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

/** 7. The PDF copy of the report (the report is already visible without it). Drills have none. */
async function renderPdf(deps: EvaluationDeps, s: Session) {
  if (isDrill(s)) return;
  await renderRevisionPdf(deps, String(s._id), 0);
}

/** Renders (once) the PDF of one report revision: revision 0 in the pipeline, later ones after a review. */
export async function renderRevisionPdf(
  deps: Pick<EvaluationDeps, 'storage' | 'now'>,
  sessionId: string,
  revision: number,
) {
  const report = await InterviewReportModel.findOne({ sessionId, revision }).lean();
  if (!report) throw new Error('report missing');
  if (report.pdf.status === 'READY') return;
  const pdf = await renderReportPdf(report.content);
  const key = `reports/${String(report.userId)}/${sessionId}/r${revision}.pdf`;
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
  // The drill result is shown as soon as the candidate finishes; no email.
  if (isDrill(s)) return;
  if (!deps.email || (deps.emailEnabled && !deps.emailEnabled())) {
    deps.logger.info({ sessionId: String(s._id) }, 'email disabled; report-ready notice skipped');
    return;
  }
  const user = await UserModel.findById(s.userId, { primaryEmail: 1, emailVerifiedAt: 1 }).lean();
  if (!user?.primaryEmail || !user.emailVerifiedAt) return;
  const turns = await InterviewTurnModel.find({ sessionId: s._id }, { answer: 1 }).lean();
  const language = outputLanguage(s.language, answerTexts(turns));
  if (!(await candidateSeesReport(s))) {
    await deps.email.send({ to: user.primaryEmail, ...submittedEmail(language) });
    return;
  }
  const link = `${deps.candidateUrl.replace(/\/$/, '')}/app/reports/${String(s._id)}`;
  await deps.email.send({ to: user.primaryEmail, ...reportReadyEmail(language, link) });
}

const HANDLERS: Record<ProcessingStage, (deps: EvaluationDeps, s: Session) => Promise<void>> = {
  FINALIZE_TRANSCRIPT: finalizeTranscript,
  EXTRACT_EVIDENCE: extractEvidence,
  SCORE_DIMENSIONS: scoreDimensions,
  AGGREGATE: aggregateScores,
  RECOMMENDATIONS: recommendations,
  COACHING: coachAnswers,
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
