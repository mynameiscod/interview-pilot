import {
  BlueprintContent,
  type BlueprintDraftAi,
  type RoleAnalysis,
  type RoleAnalysisAi,
  type TemplateContent,
} from '@cbi/shared-types';

/**
 * Integer weights proportional to `raw` that sum to exactly `total`, each at
 * least 1 (largest-remainder method; ties go to the earlier item).
 */
export function distributeWeights(raw: readonly number[], total = 100): number[] {
  if (raw.length === 0) return [];
  if (raw.length > total) throw new Error('more items than weight units');
  const positive = raw.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = positive.reduce((a, b) => a + b, 0);
  const shares = positive.map((w) => (sum > 0 ? w / sum : 1 / raw.length));
  // Reserve 1 per item, spread the rest proportionally.
  const spare = total - raw.length;
  const exact = shares.map((s) => s * spare);
  const out = exact.map((x) => 1 + Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/** Lower-case words joined by hyphens, as BlueprintContent keys require. */
export function slugify(value: string, maxLength = 60): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * Turns the model's draft into valid BlueprintContent: slug keys that are
 * unique, and competency weights rescaled to sum to 100. Anything else that
 * is wrong still fails validation (and the caller falls back).
 */
export function normalizeBlueprintDraft(draft: BlueprintDraftAi): BlueprintContent {
  const used = new Set<string>();
  const weights = distributeWeights(draft.competencies.map((c) => c.weight));
  const competencies = draft.competencies.map((c, i) => {
    let key = slugify(c.key) || slugify(c.name);
    if (key.length < 2 || used.has(key)) {
      let n = i + 1;
      while (used.has(`competency-${n}`)) n += 1;
      key = `competency-${n}`;
    }
    used.add(key);
    return { ...c, key, weight: weights[i]!, roundTypes: [...new Set(c.roundTypes)] };
  });
  return BlueprintContent.parse({ ...draft, schemaVersion: 1, competencies });
}

export type PlannedRound = RoleAnalysis['plannedRounds'][number];

/** Which competencies each template round focuses on (top 3 by weight). */
export function planRounds(
  template: Pick<TemplateContent, 'rounds'>,
  blueprint: Pick<BlueprintContent, 'competencies'>,
): PlannedRound[] {
  return template.rounds.map((round) => ({
    type: round.type,
    durationSec: round.durationSec,
    focus: blueprint.competencies
      .filter((c) => c.roundTypes.includes(round.type))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((c) => c.name),
  }));
}

const normalizeTitle = (value: string) =>
  value
    .toLowerCase()
    .replace(/\b(sr|senior|jr|junior|lead|principal|staff|intern|trainee|associate|mid)\b\.?/g, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();

export interface MatchableRole {
  slug: string;
  title: string;
  aliases: readonly string[];
}

/** Exact match on title or alias, ignoring case, punctuation and seniority words. */
export function matchRoleByTitle(title: string, roles: readonly MatchableRole[]): string | null {
  const wanted = normalizeTitle(title);
  if (!wanted) return null;
  for (const role of roles) {
    if ([role.title, ...role.aliases].some((t) => normalizeTitle(t) === wanted)) return role.slug;
  }
  return null;
}

/**
 * The analysis used when `role.analyze` is unavailable but the candidate
 * picked a library role: skills come from the canonical blueprint.
 */
export function analysisFromBlueprint(blueprint: BlueprintContent): RoleAnalysisAi {
  const source = blueprint.focusSkills.length
    ? blueprint.focusSkills.map((s) => ({ name: s.name, weight: s.weight }))
    : blueprint.competencies.map((c) => ({ name: c.name, weight: c.weight }));
  return {
    roleTitle: blueprint.role.title,
    family: blueprint.role.family,
    seniority: blueprint.role.seniority,
    confidence: 0.5,
    matchedRoleSlug: null,
    skills: source
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12)
      .map((s) => ({ ...s, sources: ['ROLE' as const], inResume: false })),
    resumeHighlights: [],
    gaps: [],
  };
}
