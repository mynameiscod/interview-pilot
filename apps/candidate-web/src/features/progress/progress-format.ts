import type {
  CompetencyCategory,
  DimensionTrend,
  ProgressOverview,
  RoundType,
} from '@cbi/shared-types';

/** Where "Practise this" goes: the drill start screen for one dimension. */
export const drillPath = (dimensionKey: string) =>
  `/app/drills/new?dimension=${encodeURIComponent(dimensionKey)}`;

/** Reads a design token (a CSS custom property such as `--cb-primary`) at runtime. */
export function cssToken(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Current dimensions, weakest first (unscored after scored). */
export function weakest(dimensions: readonly DimensionTrend[]): DimensionTrend[] {
  return dimensions
    .filter((d) => d.current)
    .sort((a, b) => (a.latest ?? 101) - (b.latest ?? 101) || a.name.localeCompare(b.name));
}

/** The practice-area tiles and the dimension categories each one drills. */
export const PRACTICE_AREAS: readonly {
  type: Extract<RoundType, 'TECHNICAL' | 'PROBLEM_SOLVING' | 'CODING' | 'BEHAVIORAL'>;
  icon: string;
  categories: readonly CompetencyCategory[];
}[] = [
  { type: 'TECHNICAL', icon: 'bi-code-slash', categories: ['TECHNICAL', 'DOMAIN'] },
  { type: 'PROBLEM_SOLVING', icon: 'bi-diagram-3', categories: ['PROBLEM_SOLVING'] },
  // Coding needs the editor and a full interview's coding round.
  { type: 'CODING', icon: 'bi-terminal', categories: [] },
  { type: 'BEHAVIORAL', icon: 'bi-chat-square-text', categories: ['BEHAVIORAL', 'COMMUNICATION'] },
];

/**
 * Where a practice-area tile leads: a drill on the weakest current dimension
 * in that area when there is one, otherwise a new interview.
 */
export function areaLink(
  categories: readonly CompetencyCategory[],
  progress: Pick<ProgressOverview, 'dimensions'> | undefined,
): { to: string; dimension: DimensionTrend | null } {
  const dimension =
    weakest(progress?.dimensions ?? []).find(
      (d) => d.category !== null && categories.includes(d.category),
    ) ?? null;
  return { to: dimension ? drillPath(dimension.key) : '/app/new', dimension };
}

/** A signed difference for display: +5, −3, 0. */
export function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}
