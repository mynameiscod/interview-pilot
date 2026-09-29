import { renderPrompt, untrusted, type PromptValue } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import {
  ExtractEvidenceAi,
  IMPROVED_ANSWER_PLACEHOLDERS,
  QuestionFeedbackAi,
  RecommendationsAi,
  ScoreDimensionAi,
  type AiFeature,
  type BlueprintContent,
  type RoundType,
} from '@cbi/shared-types';
import type { z } from 'zod';
import { groundImprovedAnswer } from './improved-answer.js';
import { LANGUAGE_NAMES, type OutputLanguage } from './language.js';
import { verifyQuotes } from './quotes.js';

/**
 * The AI steps of evaluation, shared by the pipeline and the AI regression
 * runner so both exercise exactly the same prompts, inputs and validation.
 */

export interface AiStepDeps {
  ai: AiRuntime;
  logger: Logger;
}

export interface AiCallContext {
  userId?: string;
  sessionId?: string;
}

type Competency = BlueprintContent['competencies'][number];

export async function runAiStep<T>(
  deps: AiStepDeps,
  feature: AiFeature,
  schema: z.ZodType<T>,
  values: Record<string, PromptValue>,
  ctx: AiCallContext = {},
): Promise<{ data: T; promptVersion: number; model: string } | null> {
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
      { ...ctx, prompt: { key: prompt.key, version: prompt.version } },
    );
    return { data: result.data, promptVersion: prompt.version, model: result.model.modelId };
  } catch (err) {
    deps.logger.warn({ err, feature, sessionId: ctx.sessionId }, 'evaluation ai call failed');
    return null;
  }
}

export const bullets = (items: readonly string[]) =>
  items.length ? items.map((x) => `- ${x}`).join('\n') : '-';

export interface TurnForExtraction {
  questionId: string;
  competencyKey: string | null;
  question: string;
  answer: string;
  /** Spoken and transcribed by a speech model (voice interviews). */
  spoken?: boolean;
}

/** Tells the extractor that wording slips in a spoken answer came from transcription, not the candidate. */
export const SPOKEN_ANSWER_LABEL =
  'Answer (spoken, automatically transcribed; ignore transcription slips and filler words)';

export interface ExtractedEvidence {
  questionId: string;
  competencyKey: string;
  claim: string;
  strength: number;
  confidence: number;
  practical: boolean;
  quote: string | null;
  uncertainty: string | null;
}

/**
 * Evidence for one round's answered questions. Items naming unknown
 * questions or competencies are dropped, and quotes that cannot be found in
 * the cited answer are removed (lowering that item's confidence). Null when
 * the model is unavailable.
 */
export async function extractEvidenceWithAi(
  deps: AiStepDeps,
  input: {
    roundType: RoundType;
    competencies: readonly Competency[];
    turns: readonly TurnForExtraction[];
  },
  ctx?: AiCallContext,
): Promise<{ items: ExtractedEvidence[]; promptVersion: number; unverifiedQuotes: number } | null> {
  const keys = new Set(input.competencies.map((c) => c.key));
  const questionIds = new Set(input.turns.map((t) => t.questionId));
  const result = await runAiStep(
    deps,
    'evaluation.extractEvidence',
    ExtractEvidenceAi,
    {
      roundType: input.roundType,
      competencies: input.competencies
        .map((c) => `${c.key}: ${c.name} - ${c.expectedEvidence.join('; ')}`)
        .join('\n'),
      turns: untrusted(
        input.turns
          .map(
            (t) =>
              `[${t.questionId}] Competency: ${t.competencyKey ?? 'any'}\nQuestion: ${t.question}\n${t.spoken ? SPOKEN_ANSWER_LABEL : 'Answer'}: ${t.answer}`,
          )
          .join('\n\n'),
      ),
    },
    ctx,
  );
  if (!result) return null;
  const known = result.data.items.filter(
    (i) => questionIds.has(i.questionId) && keys.has(i.competencyKey),
  );
  const answers = new Map(input.turns.map((t) => [t.questionId, t.answer]));
  const { items, unverified } = verifyQuotes(known, answers);
  if (unverified > 0) {
    // Metric: evaluation.quote_unverified (counted by log-based metrics).
    deps.logger.warn(
      {
        metric: 'evaluation.quote_unverified',
        unverified,
        quoted: known.filter((i) => i.quote?.trim()).length,
        promptVersion: result.promptVersion,
        model: result.model,
        sessionId: ctx?.sessionId,
      },
      'evidence quotes not found in the answers were removed',
    );
  }
  return { items, promptVersion: result.promptVersion, unverifiedQuotes: unverified };
}

/**
 * One dimension's score from its evidence and rubric only. Evidence ids the
 * model cites that were not given are dropped. Null when unavailable.
 */
export async function scoreDimensionWithAi(
  deps: AiStepDeps,
  input: {
    role: string;
    competency: Competency;
    evidence: readonly { id: string; strength: number; practical: boolean; claim: string }[];
  },
  ctx?: AiCallContext,
): Promise<{
  score: number;
  rationale: string;
  evidenceIds: string[];
  promptVersion: number;
} | null> {
  const ids = new Set(input.evidence.map((e) => e.id));
  const result = await runAiStep(
    deps,
    'evaluation.scoreDimension',
    ScoreDimensionAi,
    {
      role: input.role,
      competency: input.competency.name,
      description: input.competency.description,
      expectedEvidence: bullets(input.competency.expectedEvidence),
      evidence: untrusted(
        input.evidence
          .map((e) => `${e.id} | ${e.strength} | ${e.practical ? 'practical' : '-'} | ${e.claim}`)
          .join('\n'),
      ),
    },
    ctx,
  );
  if (!result) return null;
  return {
    score: result.data.score,
    rationale: result.data.rationale,
    evidenceIds: result.data.evidenceIds.filter((id) => ids.has(id)),
    promptVersion: result.promptVersion,
  };
}

/** Strengths, gaps and plan, written in the candidate's output language. */
export async function recommendationsWithAi(
  deps: AiStepDeps,
  values: {
    language: OutputLanguage;
    role: string;
    overall: string;
    confidence: string;
    dimensions: string;
    evidence: string;
    gaps: string;
  },
  ctx?: AiCallContext,
) {
  return runAiStep(
    deps,
    'report.recommendations',
    RecommendationsAi,
    {
      language: LANGUAGE_NAMES[values.language],
      role: values.role,
      overall: values.overall,
      confidence: values.confidence,
      dimensions: values.dimensions,
      evidence: untrusted(values.evidence || '-'),
      gaps: untrusted(values.gaps),
    },
    ctx,
  );
}

export interface QuestionFeedbackInput {
  language: OutputLanguage;
  role: string;
  roundType: RoundType;
  behavioural: boolean;
  competency: string | null;
  expectedEvidence: readonly string[];
  question: string;
  answer: string;
  spoken?: boolean;
  /** Evidence already extracted for this answer (claims are model output about untrusted text). */
  evidence: readonly { claim: string; strength: number }[];
}

/**
 * Coaching for one answer: verdict, what worked, what was missing, an example
 * answer rewritten from the candidate's own content and (behavioural
 * questions) STAR coverage. The example is checked against the answer:
 * invented numbers become placeholders and an invented name withholds it
 * (`improved-answer.ts`). Null when the model is unavailable.
 */
export async function questionFeedbackWithAi(
  deps: AiStepDeps,
  input: QuestionFeedbackInput,
  ctx?: AiCallContext,
): Promise<{
  data: QuestionFeedbackAi;
  promptVersion: number;
  /** What the check found in the model's example answer (before it was repaired or withheld). */
  grounding: { replacedNumbers: number; ungroundedNames: number };
} | null> {
  const placeholders = IMPROVED_ANSWER_PLACEHOLDERS[input.language];
  const result = await runAiStep(
    deps,
    'report.questionFeedback',
    QuestionFeedbackAi,
    {
      language: LANGUAGE_NAMES[input.language],
      role: input.role,
      roundType: input.roundType,
      behavioural: input.behavioural ? 'yes' : 'no',
      competency: input.competency ?? 'general',
      expectedEvidence: bullets(input.expectedEvidence),
      question: input.question,
      answer: untrusted(input.spoken ? `(${SPOKEN_ANSWER_LABEL})\n${input.answer}` : input.answer),
      assessment: untrusted(
        input.evidence.map((e) => `${e.claim} | ${e.strength}`).join('\n') || '-',
      ),
      placeholderMetric: placeholders.metric,
      placeholderName: placeholders.name,
    },
    ctx,
  );
  if (!result) return null;
  const grounded = groundImprovedAnswer(
    result.data.improvedAnswer,
    { answer: input.answer, question: input.question, role: input.role },
    input.language,
  );
  if (grounded.replacedNumbers > 0 || grounded.ungroundedNames.length > 0) {
    // Metric: evaluation.improved_answer_ungrounded (counts only, never the text).
    deps.logger.warn(
      {
        metric: 'evaluation.improved_answer_ungrounded',
        replacedNumbers: grounded.replacedNumbers,
        ungroundedNames: grounded.ungroundedNames.length,
        withheld: grounded.text === null,
        promptVersion: result.promptVersion,
        model: result.model,
        sessionId: ctx?.sessionId,
      },
      'example answer used facts the candidate did not state',
    );
  }
  return {
    data: {
      ...result.data,
      improvedAnswer: grounded.text,
      // STAR applies to behavioural questions only, whatever the model returned.
      star: input.behavioural ? result.data.star : null,
    },
    promptVersion: result.promptVersion,
    grounding: {
      replacedNumbers: grounded.replacedNumbers,
      ungroundedNames: grounded.ungroundedNames.length,
    },
  };
}
