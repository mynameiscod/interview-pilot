import type { CompetencyCategory, ConfidenceLevel, ReadinessBand } from '@cbi/shared-types';

/**
 * Deterministic scoring (design §8, stages 5–6). Pure functions only: the
 * same evidence and scores always produce the same overall score, band and
 * confidence. The AI contributes evidence and per-dimension scores; this
 * package decides what they add up to and how far an AI score may drift
 * from the evidence behind it.
 */

// ---- Weights ------------------------------------------------------------------------------

export interface WeightedDimension {
  key: string;
  category: CompetencyCategory;
  /** The competency's weight in the blueprint (relative, within its category). */
  weight: number;
}

export type CategoryWeights = Partial<Record<CompetencyCategory, number>>;

/**
 * Each dimension's share of the overall score (fractions summing to 1). The
 * template's category weight sets how much a category counts; the blueprint's
 * competency weights split that share inside the category. Categories the
 * blueprint does not cover drop out and the rest are renormalised. If every
 * covered category is weighted 0, competency weights are used on their own.
 */
export function effectiveWeights(
  dims: readonly WeightedDimension[],
  categoryWeights: CategoryWeights,
): Record<string, number> {
  const byCategory = new Map<CompetencyCategory, WeightedDimension[]>();
  for (const d of dims) byCategory.set(d.category, [...(byCategory.get(d.category) ?? []), d]);

  const raw: Record<string, number> = {};
  for (const [category, members] of byCategory) {
    const categoryWeight = Math.max(0, categoryWeights[category] ?? 0);
    const inside = members.reduce((s, d) => s + Math.max(0, d.weight), 0);
    for (const d of members) {
      const share = inside > 0 ? Math.max(0, d.weight) / inside : 1 / members.length;
      raw[d.key] = categoryWeight * share;
    }
  }
  let total = Object.values(raw).reduce((a, b) => a + b, 0);
  if (total === 0) {
    for (const d of dims) raw[d.key] = Math.max(0, d.weight);
    total = Object.values(raw).reduce((a, b) => a + b, 0);
  }
  if (total === 0) {
    // Nothing is weighted at all: treat dimensions equally.
    for (const d of dims) raw[d.key] = 1;
    total = dims.length;
  }
  return Object.fromEntries(dims.map((d) => [d.key, total > 0 ? raw[d.key]! / total : 0]));
}

// ---- Evidence ------------------------------------------------------------------------------

export interface EvidenceItem {
  id: string;
  questionId: string;
  competencyKey: string;
  /** -2 … +2 */
  strength: number;
  /** 0 … 1 */
  confidence: number;
  /** A concrete example, number, decision or result. */
  practical: boolean;
}

export interface EvidenceStats {
  count: number;
  /** Distinct questions that produced evidence. */
  questions: number;
  /** Practical items with positive strength. */
  practical: number;
  positive: number;
  negative: number;
  /** Confidence-weighted mean strength, or null without evidence. */
  meanStrength: number | null;
  /** Population standard deviation of strengths (0 … 2). */
  spread: number;
}

export function evidenceStats(items: readonly EvidenceItem[]): EvidenceStats {
  if (items.length === 0) {
    return {
      count: 0,
      questions: 0,
      practical: 0,
      positive: 0,
      negative: 0,
      meanStrength: null,
      spread: 0,
    };
  }
  const weights = items.map((i) => Math.min(1, Math.max(0.05, i.confidence)));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const mean = items.reduce((s, i, k) => s + i.strength * weights[k]!, 0) / weightSum;
  const plainMean = items.reduce((s, i) => s + i.strength, 0) / items.length;
  const variance = items.reduce((s, i) => s + (i.strength - plainMean) ** 2, 0) / items.length;
  return {
    count: items.length,
    questions: new Set(items.map((i) => i.questionId)).size,
    practical: items.filter((i) => i.practical && i.strength > 0).length,
    positive: items.filter((i) => i.strength > 0).length,
    negative: items.filter((i) => i.strength < 0).length,
    meanStrength: round(mean, 4),
    spread: round(Math.sqrt(variance), 4),
  };
}

/** Maps a mean strength (-2 … +2) onto 0 … 100. */
export const strengthScore = (meanStrength: number) =>
  Math.round(((clamp(meanStrength, -2, 2) + 2) / 4) * 100);

// ---- Guarding AI scores ------------------------------------------------------------------------

/** How far an AI dimension score may move away from what its evidence supports. */
export const SCORE_GUARD_BAND = 25;

export interface GuardedScore {
  score: number | null;
  /** The AI score was pulled back inside the evidence band. */
  adjusted: boolean;
  /** No AI score was available; the evidence alone produced the score. */
  fallback: boolean;
}

/**
 * Evidence-first scoring, enforced structurally: no evidence means no score,
 * and an AI score (which could be pushed around by, for example, an injected
 * instruction in an answer) is clamped to ±SCORE_GUARD_BAND of the score the
 * evidence strengths imply.
 */
export function guardScore(aiScore: number | null, stats: EvidenceStats): GuardedScore {
  if (stats.count === 0 || stats.meanStrength === null) {
    return { score: null, adjusted: false, fallback: false };
  }
  const base = strengthScore(stats.meanStrength);
  if (aiScore === null || !Number.isFinite(aiScore)) {
    return { score: base, adjusted: false, fallback: true };
  }
  const bounded = clamp(
    Math.round(aiScore),
    Math.max(0, base - SCORE_GUARD_BAND),
    Math.min(100, base + SCORE_GUARD_BAND),
  );
  return { score: bounded, adjusted: bounded !== Math.round(aiScore), fallback: false };
}

// ---- Aggregation -----------------------------------------------------------------------------------

/** Below this share of scored weight there is no overall score. */
export const MIN_ASSESSED_WEIGHT = 0.5;

export interface ScoredDimension extends WeightedDimension {
  score: number | null;
}

export interface Aggregate {
  overall: number | null;
  /** Share of the total weight that was scored (0 … 1, 4 decimals). */
  assessedWeight: number;
  /** Each dimension's share of the overall score in percent (1 decimal). */
  weightsPercent: Record<string, number>;
}

/** Weighted mean of the scored dimensions; unscored dimensions are left out, not counted as 0. */
export function aggregate(
  dims: readonly ScoredDimension[],
  categoryWeights: CategoryWeights,
): Aggregate {
  const weights = effectiveWeights(dims, categoryWeights);
  let scoredWeight = 0;
  let sum = 0;
  for (const d of dims) {
    if (d.score === null) continue;
    const w = weights[d.key]!;
    scoredWeight += w;
    sum += w * clamp(d.score, 0, 100);
  }
  const assessedWeight = round(scoredWeight, 4);
  return {
    overall:
      scoredWeight > 0 && assessedWeight >= MIN_ASSESSED_WEIGHT
        ? Math.round(sum / scoredWeight)
        : null,
    assessedWeight,
    weightsPercent: Object.fromEntries(dims.map((d) => [d.key, round(weights[d.key]! * 100, 1)])),
  };
}

// ---- Confidence -------------------------------------------------------------------------------------

export interface ConfidenceInput {
  /** Distinct questions whose answers produced evidence. */
  independentQuestions: number;
  practicalEvidence: number;
  /** Evidence statistics of the scored dimensions. */
  dimensionStats: readonly EvidenceStats[];
  /** |AI score − evidence score| for dimensions with an AI score. */
  scoreGaps: readonly number[];
  assessedWeight: number;
}

export interface Confidence {
  value: number;
  level: ConfidenceLevel;
  factors: {
    independentQuestions: number;
    practicalEvidence: number;
    consistency: number;
    completeness: number;
  };
}

/** Enough independent questions and practical examples for full marks on those factors. */
export const CONFIDENCE_TARGETS = { independentQuestions: 8, practicalEvidence: 5 } as const;

/**
 * How much the result can be trusted (design §8 stage 6): the number of
 * independent questions, practical evidence, consistency (evidence within a
 * dimension agrees; AI scores agree with the evidence) and completeness
 * (share of the weight that was scored).
 */
export function confidence(input: ConfidenceInput): Confidence {
  const independentQuestions = clamp(
    input.independentQuestions / CONFIDENCE_TARGETS.independentQuestions,
    0,
    1,
  );
  const practicalEvidence = clamp(
    input.practicalEvidence / CONFIDENCE_TARGETS.practicalEvidence,
    0,
    1,
  );
  const agreement = input.dimensionStats.length
    ? 1 - mean(input.dimensionStats.map((s) => clamp(s.spread / 2, 0, 1)))
    : null;
  const scoreAgreement = input.scoreGaps.length
    ? 1 - clamp(mean(input.scoreGaps) / SCORE_GUARD_BAND, 0, 1)
    : null;
  const parts = [agreement, scoreAgreement].filter((x): x is number => x !== null);
  const consistency = parts.length ? mean(parts) : 0;
  const completeness = clamp(input.assessedWeight, 0, 1);
  const value = round(
    0.3 * independentQuestions + 0.25 * practicalEvidence + 0.2 * consistency + 0.25 * completeness,
    2,
  );
  return {
    value,
    level: value >= 0.7 ? 'HIGH' : value >= 0.45 ? 'MEDIUM' : 'LOW',
    factors: {
      independentQuestions: round(independentQuestions, 2),
      practicalEvidence: round(practicalEvidence, 2),
      consistency: round(consistency, 2),
      completeness: round(completeness, 2),
    },
  };
}

// ---- Readiness -----------------------------------------------------------------------------------------

export const READINESS_THRESHOLDS = { READY: 80, READY_WITH_GAPS: 65, DEVELOPING: 50 } as const;

export function readinessBand(overall: number | null): ReadinessBand {
  if (overall === null) return 'INSUFFICIENT_EVIDENCE';
  if (overall >= READINESS_THRESHOLDS.READY) return 'READY';
  if (overall >= READINESS_THRESHOLDS.READY_WITH_GAPS) return 'READY_WITH_GAPS';
  if (overall >= READINESS_THRESHOLDS.DEVELOPING) return 'DEVELOPING';
  return 'NOT_YET';
}

// ---- Comparing attempts ----------------------------------------------------------------------------------

export interface AttemptDimensions {
  dimensions: readonly { key: string; name: string; score: number | null }[];
}

/**
 * Dimension scores across attempts (oldest first) with the change from the
 * first to the last attempt where both were scored. Dimensions keep the
 * order in which they first appear.
 */
export function compareAttempts(attempts: readonly AttemptDimensions[]) {
  const order: { key: string; name: string }[] = [];
  for (const a of attempts) {
    for (const d of a.dimensions)
      if (!order.some((o) => o.key === d.key)) order.push({ key: d.key, name: d.name });
  }
  return order.map(({ key, name }) => {
    const scores = attempts.map((a) => a.dimensions.find((d) => d.key === key)?.score ?? null);
    const first = scores[0];
    const last = scores[scores.length - 1];
    return {
      key,
      name,
      scores,
      delta:
        first !== null && first !== undefined && last !== null && last !== undefined
          ? last - first
          : null,
    };
  });
}

// ---- helpers ------------------------------------------------------------------------------------------------

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
function mean(values: readonly number[]) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function round(n: number, digits: number) {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}
