import type {
  BlueprintContent,
  CompetencyCategory,
  Difficulty,
  QuestionSource,
  RoundState,
  RoundType,
  TemplateRound,
  TurnSufficiency,
} from '@cbi/shared-types';

/**
 * The question planner (design §6.3). Pure: it decides what to ask next from
 * the blueprint, the template's rounds, coverage so far and the time left,
 * and it records what was asked and how the answer was assessed. The
 * orchestrator persists `PlannerState` on the session after every step.
 */

type Competency = BlueprintContent['competencies'][number];
type ProbeArea = BlueprintContent['probeAreas'][number];

export interface PlannerRound {
  type: RoundType;
  budgetMs: number;
  questionCount: number;
  difficulty: TemplateRound['difficulty'];
  followUpDepth: number;
  minEvidence: number;
  state: RoundState;
  /** Interview clock reading (elapsed ms) when the round started. */
  startedAtMs: number | null;
  primaryAsked: number;
  evidence: number;
}

export interface CompetencyCoverage {
  asked: number;
  strong: number;
  adequate: number;
  weak: number;
  lastSufficiency: TurnSufficiency | null;
}

export interface PlannerThread {
  competencyKey: string | null;
  rootQuestionId: string;
  lastQuestionId: string;
  depth: number;
  /** Set after an assessment asks for a follow-up the round still allows. */
  pendingFollowUp: { angle: string | null } | null;
}

export interface PlannerState {
  version: 1;
  /** -1 until the first round starts. */
  roundIdx: number;
  rounds: PlannerRound[];
  coverage: Record<string, CompetencyCoverage>;
  thread: PlannerThread | null;
  /** Probe areas (by topic) already used for a question. */
  probesUsed: string[];
  askedCount: number;
  /** Answers with content (NO_ANSWER is not counted). */
  answeredCount: number;
}

export interface QuestionTarget {
  roundIdx: number;
  roundType: RoundType;
  competencyKey: string | null;
  competencyName: string | null;
  source: QuestionSource;
  difficulty: Difficulty;
  objective: string;
  expectedEvidence: string[];
  followUpOf: string | null;
  followUpDepth: number;
  followUpAngle: string | null;
  /** The resume/JD probe area this question uses, if any. */
  probeTopic: string | null;
}

export type NextStep =
  | { kind: 'ASK'; target: QuestionTarget }
  | { kind: 'END_ROUND'; reason: 'COMPLETED' | 'TIMED_OUT' };

/** A new primary question needs at least this much round time left. */
export const MIN_QUESTION_MS = 60_000;

/** Suitable categories when no competency names a round type (mirrors analysis planning). */
const ROUND_CATEGORIES: Partial<Record<RoundType, readonly CompetencyCategory[]>> = {
  TECHNICAL: ['TECHNICAL', 'DOMAIN'],
  CODING: ['TECHNICAL'],
  PROBLEM_SOLVING: ['PROBLEM_SOLVING', 'TECHNICAL'],
  BEHAVIORAL: ['BEHAVIORAL', 'COMMUNICATION'],
};

/** Rounds where resume and JD probe areas are worth using. */
const PROBE_ROUNDS: readonly RoundType[] = ['TECHNICAL', 'PROBLEM_SOLVING', 'CODING'];

const DIFFICULTY_ORDER: readonly Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];

const OPEN_OBJECTIVES: Partial<Record<RoundType, string>> = {
  INTRO:
    'Warm-up: invite the candidate to introduce themselves and the experience most relevant to this role.',
  WRAP_UP:
    'Close the interview: ask what the candidate would like to add or highlight that has not come up yet.',
};

export function createPlanner(
  rounds: readonly TemplateRound[],
  competencies: readonly Pick<Competency, 'key'>[],
): PlannerState {
  if (rounds.length === 0) throw new Error('a template needs at least one round');
  return {
    version: 1,
    roundIdx: -1,
    rounds: rounds.map((r) => ({
      type: r.type,
      budgetMs: r.durationSec * 1000,
      questionCount: r.questionCount,
      difficulty: r.difficulty,
      followUpDepth: r.followUpDepth,
      minEvidence: r.minEvidence,
      state: 'PENDING',
      startedAtMs: null,
      primaryAsked: 0,
      evidence: 0,
    })),
    coverage: Object.fromEntries(
      competencies.map((c) => [
        c.key,
        { asked: 0, strong: 0, adequate: 0, weak: 0, lastSufficiency: null },
      ]),
    ),
    thread: null,
    probesUsed: [],
    askedCount: 0,
    answeredCount: 0,
  };
}

export const currentRound = (p: PlannerState): PlannerRound | null => p.rounds[p.roundIdx] ?? null;

export const hasNextRound = (p: PlannerState) => p.roundIdx + 1 < p.rounds.length;

/** Total time budget of the interview (sum of round budgets). */
export const totalBudgetMs = (p: Pick<PlannerState, 'rounds'>) =>
  p.rounds.reduce((sum, r) => sum + r.budgetMs, 0);

function withRound(p: PlannerState, idx: number, patch: Partial<PlannerRound>): PlannerState {
  return { ...p, rounds: p.rounds.map((r, i) => (i === idx ? { ...r, ...patch } : r)) };
}

/** Ends the current round (if any) with `outcome`. Idempotent for finished rounds. */
export function endCurrentRound(
  p: PlannerState,
  outcome: 'COMPLETED' | 'TIMED_OUT' | 'SKIPPED' = 'COMPLETED',
): PlannerState {
  const round = currentRound(p);
  if (!round || round.state !== 'ACTIVE') return p;
  return { ...withRound(p, p.roundIdx, { state: outcome }), thread: null };
}

/** Finishes the current round and starts the next one at clock reading `elapsedMs`. */
export function startNextRound(p: PlannerState, elapsedMs: number): PlannerState {
  if (!hasNextRound(p)) throw new Error('no next round');
  const ended = endCurrentRound(p);
  const idx = ended.roundIdx + 1;
  return {
    ...withRound(ended, idx, { state: 'ACTIVE', startedAtMs: elapsedMs }),
    roundIdx: idx,
    thread: null,
  };
}

/** Marks every round that never ran as SKIPPED (the interview ended early). */
export function skipRemainingRounds(p: PlannerState): PlannerState {
  return {
    ...p,
    thread: null,
    rounds: p.rounds.map((r) => (r.state === 'PENDING' ? { ...r, state: 'SKIPPED' } : r)),
  };
}

export function roundRemainingMs(p: PlannerState, elapsedMs: number): number {
  const round = currentRound(p);
  if (!round || round.startedAtMs === null) return 0;
  return Math.max(0, round.budgetMs - (elapsedMs - round.startedAtMs));
}

/** Competencies a round can assess: by round type, else by category, else none. */
export function competenciesForRound(
  type: RoundType,
  competencies: readonly Competency[],
): Competency[] {
  const named = competencies.filter((c) => c.roundTypes.includes(type));
  if (named.length > 0) return named;
  const categories = ROUND_CATEGORIES[type];
  return categories ? competencies.filter((c) => categories.includes(c.category)) : [];
}

function shift(difficulty: Difficulty, by: -1 | 0 | 1): Difficulty {
  const i = DIFFICULTY_ORDER.indexOf(difficulty) + by;
  return DIFFICULTY_ORDER[Math.min(DIFFICULTY_ORDER.length - 1, Math.max(0, i))]!;
}

/** ADAPTIVE rounds move up after a strong answer and down after a weak one. */
function difficultyFor(
  round: PlannerRound,
  competency: Competency | null,
  coverage: CompetencyCoverage | undefined,
): Difficulty {
  if (round.difficulty !== 'ADAPTIVE') return round.difficulty;
  const base = competency?.difficulty ?? 'MEDIUM';
  switch (coverage?.lastSufficiency) {
    case 'STRONG':
      return shift(base, 1);
    case 'WEAK':
    case 'NO_ANSWER':
      return shift(base, -1);
    default:
      return base;
  }
}

/** Least-covered first, then the heaviest; ties by key for determinism. */
function pickCompetency(
  candidates: readonly Competency[],
  coverage: PlannerState['coverage'],
): Competency | null {
  const asked = (c: Competency) => coverage[c.key]?.asked ?? 0;
  return (
    [...candidates].sort(
      (a, b) => asked(a) - asked(b) || b.weight - a.weight || a.key.localeCompare(b.key),
    )[0] ?? null
  );
}

/**
 * The next thing to do in the current round: ask a (follow-up) question or
 * end the round. `elapsedMs` is the interview clock reading.
 */
export function nextStep(
  p: PlannerState,
  blueprint: Pick<BlueprintContent, 'competencies' | 'probeAreas'>,
  elapsedMs: number,
): NextStep {
  const round = currentRound(p);
  if (!round || round.state !== 'ACTIVE') throw new Error('no active round');
  const remaining = roundRemainingMs(p, elapsedMs);
  if (remaining <= 0) return { kind: 'END_ROUND', reason: 'TIMED_OUT' };

  const byKey = new Map(blueprint.competencies.map((c) => [c.key, c]));

  // A follow-up continues the current thread even when the round is nearly out of time.
  const thread = p.thread;
  if (thread?.pendingFollowUp) {
    const competency = thread.competencyKey ? (byKey.get(thread.competencyKey) ?? null) : null;
    return {
      kind: 'ASK',
      target: {
        roundIdx: p.roundIdx,
        roundType: round.type,
        competencyKey: competency?.key ?? null,
        competencyName: competency?.name ?? null,
        source: 'FOLLOW_UP',
        difficulty: difficultyFor(
          round,
          competency,
          competency ? p.coverage[competency.key] : undefined,
        ),
        objective: thread.pendingFollowUp.angle
          ? `Follow up: ${thread.pendingFollowUp.angle}`
          : `Follow up on the previous answer to get more specific evidence${competency ? ` of ${competency.name}` : ''}.`,
        expectedEvidence: competency?.expectedEvidence ?? [],
        followUpOf: thread.lastQuestionId,
        followUpDepth: thread.depth + 1,
        followUpAngle: thread.pendingFollowUp.angle,
        probeTopic: null,
      },
    };
  }

  if (round.primaryAsked >= round.questionCount) return { kind: 'END_ROUND', reason: 'COMPLETED' };
  if (round.primaryAsked > 0 && remaining < MIN_QUESTION_MS) {
    return { kind: 'END_ROUND', reason: 'TIMED_OUT' };
  }

  const competency = pickCompetency(
    competenciesForRound(round.type, blueprint.competencies),
    p.coverage,
  );
  const probe: ProbeArea | undefined =
    PROBE_ROUNDS.includes(round.type) && round.primaryAsked > 0
      ? blueprint.probeAreas.find((a) => !p.probesUsed.includes(a.topic))
      : undefined;

  const objective = probe
    ? `Probe: ${probe.topic}. ${probe.reason}`
    : competency
      ? `Assess ${competency.name}: ${competency.description}`
      : (OPEN_OBJECTIVES[round.type] ?? `Ask an open ${round.type.toLowerCase()} question.`);

  return {
    kind: 'ASK',
    target: {
      roundIdx: p.roundIdx,
      roundType: round.type,
      competencyKey: competency?.key ?? null,
      competencyName: competency?.name ?? null,
      source: probe ? probe.source : 'ROLE',
      difficulty: difficultyFor(
        round,
        competency,
        competency ? p.coverage[competency.key] : undefined,
      ),
      objective,
      expectedEvidence: competency?.expectedEvidence ?? [],
      followUpOf: null,
      followUpDepth: 0,
      followUpAngle: null,
      probeTopic: probe?.topic ?? null,
    },
  };
}

/** Records that `target` was asked as question `questionId`. */
export function recordQuestion(
  p: PlannerState,
  target: QuestionTarget,
  questionId: string,
): PlannerState {
  const round = currentRound(p);
  if (!round || round.state !== 'ACTIVE' || target.roundIdx !== p.roundIdx) {
    throw new Error('question does not belong to the active round');
  }
  const isFollowUp = target.followUpOf !== null;
  const coverage = { ...p.coverage };
  if (target.competencyKey) {
    const prev = coverage[target.competencyKey] ?? {
      asked: 0,
      strong: 0,
      adequate: 0,
      weak: 0,
      lastSufficiency: null,
    };
    coverage[target.competencyKey] = { ...prev, asked: prev.asked + 1 };
  }
  const probeTopic = isFollowUp ? null : target.probeTopic;
  return {
    ...withRound(p, p.roundIdx, { primaryAsked: round.primaryAsked + (isFollowUp ? 0 : 1) }),
    coverage,
    probesUsed: probeTopic ? [...p.probesUsed, probeTopic] : p.probesUsed,
    askedCount: p.askedCount + 1,
    thread: {
      competencyKey: target.competencyKey,
      rootQuestionId: isFollowUp && p.thread ? p.thread.rootQuestionId : questionId,
      lastQuestionId: questionId,
      depth: target.followUpDepth,
      pendingFollowUp: null,
    },
  };
}

export interface TurnAssessment {
  sufficiency: TurnSufficiency;
  followUpNeeded: boolean;
  followUpAngle: string | null;
  evidenceCount: number;
}

/** Records the assessment of the answer to the thread's last question. */
export function recordAssessment(p: PlannerState, a: TurnAssessment): PlannerState {
  const round = currentRound(p);
  const thread = p.thread;
  if (!round || !thread) throw new Error('no question awaiting an assessment');
  const coverage = { ...p.coverage };
  if (thread.competencyKey && coverage[thread.competencyKey]) {
    const prev = coverage[thread.competencyKey]!;
    coverage[thread.competencyKey] = {
      ...prev,
      strong: prev.strong + (a.sufficiency === 'STRONG' ? 1 : 0),
      adequate: prev.adequate + (a.sufficiency === 'ADEQUATE' ? 1 : 0),
      weak: prev.weak + (a.sufficiency === 'WEAK' || a.sufficiency === 'NO_ANSWER' ? 1 : 0),
      lastSufficiency: a.sufficiency,
    };
  }
  const canFollowUp =
    a.followUpNeeded && a.sufficiency !== 'NO_ANSWER' && thread.depth < round.followUpDepth;
  return {
    ...withRound(p, p.roundIdx, { evidence: round.evidence + Math.max(0, a.evidenceCount) }),
    coverage,
    answeredCount: p.answeredCount + (a.sufficiency === 'NO_ANSWER' ? 0 : 1),
    thread: { ...thread, pendingFollowUp: canFollowUp ? { angle: a.followUpAngle } : null },
  };
}
