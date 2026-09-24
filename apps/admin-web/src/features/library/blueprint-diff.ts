import type { BlueprintContent } from '@cbi/shared-types';

export type Competency = BlueprintContent['competencies'][number];
export type FocusSkill = BlueprintContent['focusSkills'][number];
export type ProbeArea = BlueprintContent['probeAreas'][number];

export type FieldChange = { field: string; from: string | number; to: string | number };

export type ItemChange<T> = { key: string; item: T; changes: FieldChange[] };

export type KeyedDiff<T> = { added: T[]; removed: T[]; changed: ItemChange<T>[] };

export interface BlueprintDiff {
  role: FieldChange[];
  competencies: KeyedDiff<Competency>;
  focusSkills: KeyedDiff<FocusSkill>;
  probeAreas: KeyedDiff<ProbeArea>;
  notes: FieldChange | null;
  identical: boolean;
}

const display = (value: unknown): string | number => {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return '';
  return String(value);
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function fieldChanges<T extends object>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): FieldChange[] {
  return fields
    .filter((field) => !same(before[field], after[field]))
    .map((field) => ({ field, from: display(before[field]), to: display(after[field]) }));
}

/** Matches items by key: added/removed by presence, changed field by field. */
export function diffKeyed<T extends object>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
  fields: readonly (keyof T & string)[],
): KeyedDiff<T> {
  const beforeByKey = new Map(before.map((item) => [keyOf(item), item]));
  const afterKeys = new Set(after.map(keyOf));
  const added: T[] = [];
  const changed: ItemChange<T>[] = [];
  for (const item of after) {
    const previous = beforeByKey.get(keyOf(item));
    if (!previous) {
      added.push(item);
      continue;
    }
    const changes = fieldChanges(previous, item, fields);
    if (changes.length > 0) changed.push({ key: keyOf(item), item, changes });
  }
  const removed = before.filter((item) => !afterKeys.has(keyOf(item)));
  return { added, removed, changed };
}

const COMPETENCY_FIELDS = [
  'name',
  'category',
  'weight',
  'difficulty',
  'description',
  'subCompetencies',
  'expectedEvidence',
  'roundTypes',
] as const satisfies readonly (keyof Competency)[];

const empty = <T>(d: KeyedDiff<T>) =>
  d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;

/**
 * Field-level differences from `base` (usually the active version) to
 * `target`. Competencies are matched by key, focus skills by name and probe
 * areas by topic; a renamed key therefore shows as removed plus added.
 */
export function diffBlueprints(base: BlueprintContent, target: BlueprintContent): BlueprintDiff {
  const role = fieldChanges(base.role, target.role, ['title', 'family', 'seniority', 'summary']);
  const competencies = diffKeyed(
    base.competencies,
    target.competencies,
    (c) => c.key,
    COMPETENCY_FIELDS,
  );
  const focusSkills = diffKeyed(base.focusSkills, target.focusSkills, (s) => s.name.toLowerCase(), [
    'weight',
    'source',
  ]);
  const probeAreas = diffKeyed(base.probeAreas, target.probeAreas, (p) => p.topic.toLowerCase(), [
    'reason',
    'source',
  ]);
  const notes = same(base.notes, target.notes)
    ? null
    : { field: 'notes', from: display(base.notes), to: display(target.notes) };
  return {
    role,
    competencies,
    focusSkills,
    probeAreas,
    notes,
    identical:
      role.length === 0 &&
      empty(competencies) &&
      empty(focusSkills) &&
      empty(probeAreas) &&
      notes === null,
  };
}

/** Sum of competency weights in possibly-invalid editor content; null if unreadable. */
export function competencyWeightTotal(content: unknown): number | null {
  const list = (content as { competencies?: unknown } | null)?.competencies;
  if (!Array.isArray(list)) return null;
  return list.reduce<number>((sum, c) => {
    const weight = (c as { weight?: unknown } | null)?.weight;
    return sum + (typeof weight === 'number' && Number.isFinite(weight) ? weight : 0);
  }, 0);
}
