import {
  BlueprintContent,
  CompetencyCategory,
  type BlueprintDraftAi,
  type RoleFamily,
  type RoleAnalysis,
  type RoleAnalysisAi,
  type RoundType,
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

/**
 * Categories that suit a round when no competency names the round type
 * itself (models sometimes tag everything with one round). Intro and
 * wrap-up rounds have no fallback: an empty focus is fine there.
 */
const ROUND_CATEGORIES: Partial<Record<RoundType, readonly CompetencyCategory[]>> = {
  TECHNICAL: ['TECHNICAL', 'DOMAIN'],
  CODING: ['TECHNICAL'],
  PROBLEM_SOLVING: ['PROBLEM_SOLVING', 'TECHNICAL'],
  BEHAVIORAL: ['BEHAVIORAL', 'COMMUNICATION'],
};

/** Which competencies each template round focuses on (top 3 by weight). */
export function planRounds(
  template: Pick<TemplateContent, 'rounds'>,
  blueprint: Pick<BlueprintContent, 'competencies'>,
): PlannedRound[] {
  const top = (list: BlueprintContent['competencies']) =>
    [...list]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((c) => c.name);
  return template.rounds.map((round) => {
    let focus = top(blueprint.competencies.filter((c) => c.roundTypes.includes(round.type)));
    const categories = ROUND_CATEGORIES[round.type];
    if (focus.length === 0 && categories) {
      focus = top(blueprint.competencies.filter((c) => categories.includes(c.category)));
    }
    return { type: round.type, durationSec: round.durationSec, focus };
  });
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

/** Library roles offered to `role.analyze` (prompt size and cost control). */
export const ROLE_SHORTLIST_SIZE = 40;

const tokens = (value: string) =>
  new Set(
    normalizeTitle(value)
      .split(' ')
      .filter((t) => t.length >= 2),
  );

export interface ShortlistRole extends MatchableRole {
  family: RoleFamily;
}

/**
 * The library roles most likely to match: exact title/alias matches first,
 * then roles sharing words with the target title (weighted) and the job
 * description, with a bonus for the company's role families. Capped, so the
 * prompt does not grow with the library. Ties keep library order.
 */
export function shortlistRoles<R extends ShortlistRole>(
  roles: readonly R[],
  query: { title: string; jd?: string; families?: readonly RoleFamily[] },
  limit = ROLE_SHORTLIST_SIZE,
): R[] {
  if (roles.length <= limit) return [...roles];
  const exact = matchRoleByTitle(query.title, roles);
  const titleWords = tokens(query.title);
  const jdWords = tokens((query.jd ?? '').slice(0, 4000));
  const families = new Set(query.families ?? []);
  const scored = roles.map((role, index) => {
    let score = role.slug === exact ? 1000 : 0;
    for (const word of tokens([role.title, ...role.aliases].join(' '))) {
      if (titleWords.has(word)) score += 10;
      else if (jdWords.has(word)) score += 2;
    }
    if (families.has(role.family)) score += 5;
    return { role, score, index };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.role);
}

/**
 * Keeps only competencies in the company's allowed question categories,
 * re-weighted to 100. Returns the blueprint unchanged when no restriction
 * applies or fewer than three competencies would remain (a blueprint needs
 * at least three).
 */
export function restrictCategories(
  blueprint: BlueprintContent,
  allowed: readonly CompetencyCategory[],
): { content: BlueprintContent; removed: string[] } {
  if (allowed.length === 0) return { content: blueprint, removed: [] };
  const keep = blueprint.competencies.filter((c) => allowed.includes(c.category));
  if (keep.length === blueprint.competencies.length || keep.length < 3) {
    return { content: blueprint, removed: [] };
  }
  const weights = distributeWeights(keep.map((c) => c.weight));
  return {
    content: BlueprintContent.parse({
      ...blueprint,
      competencies: keep.map((c, i) => ({ ...c, weight: weights[i]! })),
    }),
    removed: blueprint.competencies.filter((c) => !keep.includes(c)).map((c) => c.key),
  };
}

/**
 * Company guidance appended to the verified notes in analysis prompts: the
 * question categories its interviews use and the role families it hires
 * for. Empty when the company sets neither (or allows every category).
 */
export function companyGuidance(company: {
  allowedQuestionCategories: readonly CompetencyCategory[];
  roleFamilies: readonly RoleFamily[];
}): string[] {
  const lines: string[] = [];
  const allowed = company.allowedQuestionCategories;
  if (allowed.length > 0 && allowed.length < CompetencyCategory.options.length) {
    lines.push(
      `This company's interviews only cover these question categories: ${allowed.join(', ')}. Plan competencies in these categories only.`,
    );
  }
  if (company.roleFamilies.length > 0) {
    lines.push(
      `This company hires for these role families: ${company.roleFamilies.join(', ')}. Prefer library roles in these families when they fit.`,
    );
  }
  return lines;
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
