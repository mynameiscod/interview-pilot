import { renderPrompt, untrusted, type PromptValue } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import {
  ExtractEvidenceAi,
  RecommendationsAi,
  ScoreDimensionAi,
  type AiFeature,
  type BlueprintContent,
  type RoundType,
} from '@cbi/shared-types';
import type { z } from 'zod';

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
 * questions or competencies are dropped. Null when the model is unavailable.
 */
export async function extractEvidenceWithAi(
  deps: AiStepDeps,
  input: {
    roundType: RoundType;
    competencies: readonly Competency[];
    turns: readonly TurnForExtraction[];
  },
  ctx?: AiCallContext,
): Promise<{ items: ExtractedEvidence[]; promptVersion: number } | null> {
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
  return {
    items: result.data.items.filter(
      (i) => questionIds.has(i.questionId) && keys.has(i.competencyKey),
    ),
    promptVersion: result.promptVersion,
  };
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

export async function recommendationsWithAi(
  deps: AiStepDeps,
  values: {
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
      language: 'English',
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
