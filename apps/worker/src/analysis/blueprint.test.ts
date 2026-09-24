import { BlueprintContent, type BlueprintDraftAi } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import {
  analysisFromBlueprint,
  distributeWeights,
  matchRoleByTitle,
  normalizeBlueprintDraft,
  planRounds,
  slugify,
} from './blueprint.js';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('distributeWeights', () => {
  it.each([
    [[51, 51, 51]],
    [[1, 1, 1, 1, 1, 1, 1]],
    [[90, 5, 5]],
    [[0, 0, 0, 0]],
    [[-3, Number.NaN, 10]],
    [[1000, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
  ])('sums to 100 with every weight >= 1 for %j', (raw) => {
    const out = distributeWeights(raw);
    expect(sum(out)).toBe(100);
    expect(out).toHaveLength(raw.length);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(1);
  });

  it('keeps weights that already sum to 100', () => {
    expect(distributeWeights([20, 30, 50])).toEqual([20, 30, 50]);
  });

  it('preserves order of importance', () => {
    const [a, b, c] = distributeWeights([60, 30, 10]);
    expect(a).toBeGreaterThan(b!);
    expect(b).toBeGreaterThan(c!);
  });

  it('splits evenly when nothing is positive, remainder to the earliest', () => {
    expect(distributeWeights([0, 0, 0])).toEqual([34, 33, 33]);
  });

  it('handles empty input and refuses more items than units', () => {
    expect(distributeWeights([])).toEqual([]);
    expect(() => distributeWeights([1, 1, 1], 2)).toThrow();
  });
});

describe('slugify', () => {
  it.each([
    ['System Design', 'system-design'],
    ['  API / REST design!! ', 'api-rest-design'],
    ['[mock] key', 'mock-key'],
    ['Résumé depth', 'resume-depth'],
    ['***', ''],
  ])('%j -> %j', (input, expected) => expect(slugify(input)).toBe(expected));

  it('never ends in a hyphen after truncation', () => {
    expect(slugify('abc def', 4)).toBe('abc');
  });
});

function draft(overrides: Partial<BlueprintDraftAi['competencies'][number]>[]): BlueprintDraftAi {
  return {
    schemaVersion: 1,
    role: { title: 'Backend Engineer', family: 'ENGINEERING', seniority: 'MID', summary: 'APIs' },
    competencies: overrides.map((o, i) => ({
      key: `Competency ${i}`,
      name: `Competency ${i}`,
      category: 'TECHNICAL',
      weight: 51,
      description: 'd',
      subCompetencies: [],
      expectedEvidence: ['e'],
      difficulty: 'MEDIUM',
      roundTypes: ['TECHNICAL'],
      ...o,
    })),
    focusSkills: [],
    probeAreas: [],
    notes: null,
  };
}

describe('normalizeBlueprintDraft', () => {
  it('produces valid BlueprintContent from a sloppy draft', () => {
    const out = normalizeBlueprintDraft(
      draft([{ key: 'API Design' }, { key: 'api design' }, { key: '!!', name: '??' }]),
    );
    expect(BlueprintContent.safeParse(out).success).toBe(true);
    expect(out.competencies.map((c) => c.key)).toEqual([
      'api-design',
      'competency-2',
      'competency-3',
    ]);
    expect(sum(out.competencies.map((c) => c.weight))).toBe(100);
  });

  it('falls back to the name when the key is unusable', () => {
    const out = normalizeBlueprintDraft(draft([{ key: '', name: 'Data Modelling' }, {}, {}]));
    expect(out.competencies[0]!.key).toBe('data-modelling');
  });

  it('removes duplicate round types', () => {
    const out = normalizeBlueprintDraft(
      draft([{ roundTypes: ['TECHNICAL', 'TECHNICAL', 'CODING'] }, {}, {}]),
    );
    expect(out.competencies[0]!.roundTypes).toEqual(['TECHNICAL', 'CODING']);
  });

  it('still rejects content that cannot be repaired', () => {
    const bad = draft([{}, {}, {}]);
    bad.role.title = 'x';
    expect(() => normalizeBlueprintDraft(bad)).toThrow();
  });
});

describe('planRounds', () => {
  const blueprint = normalizeBlueprintDraft(
    draft([
      { name: 'Aa', weight: 10, roundTypes: ['TECHNICAL'] },
      { name: 'Bb', weight: 40, roundTypes: ['TECHNICAL', 'BEHAVIORAL'] },
      { name: 'Cc', weight: 30, roundTypes: ['TECHNICAL'] },
      { name: 'Dd', weight: 20, roundTypes: ['TECHNICAL'] },
    ]),
  );

  it('focuses each round on its top three competencies by weight', () => {
    const rounds = planRounds(
      {
        rounds: [
          {
            type: 'INTRO',
            durationSec: 120,
            questionCount: 1,
            difficulty: 'EASY',
            followUpDepth: 0,
            minEvidence: 0,
          },
          {
            type: 'TECHNICAL',
            durationSec: 900,
            questionCount: 4,
            difficulty: 'ADAPTIVE',
            followUpDepth: 2,
            minEvidence: 2,
          },
          {
            type: 'BEHAVIORAL',
            durationSec: 300,
            questionCount: 2,
            difficulty: 'MEDIUM',
            followUpDepth: 1,
            minEvidence: 1,
          },
        ],
      },
      blueprint,
    );
    expect(rounds).toEqual([
      { type: 'INTRO', durationSec: 120, focus: [] },
      { type: 'TECHNICAL', durationSec: 900, focus: ['Bb', 'Cc', 'Dd'] },
      { type: 'BEHAVIORAL', durationSec: 300, focus: ['Bb'] },
    ]);
  });
});

describe('matchRoleByTitle', () => {
  const roles = [
    { slug: 'backend-engineer', title: 'Backend Engineer', aliases: ['Node.js Developer'] },
    { slug: 'qa-engineer', title: 'QA Engineer', aliases: ['Software Tester'] },
  ];

  it.each([
    ['Backend Engineer', 'backend-engineer'],
    ['Senior Backend Engineer', 'backend-engineer'],
    ['backend engineer (Sr.)', 'backend-engineer'],
    ['node.js developer', 'backend-engineer'],
    ['Software Tester', 'qa-engineer'],
    ['Data Scientist', null],
    ['', null],
  ])('%j -> %j', (title, slug) => expect(matchRoleByTitle(title, roles)).toBe(slug));
});

describe('analysisFromBlueprint', () => {
  it('derives skills from the canonical blueprint', () => {
    const blueprint = normalizeBlueprintDraft(
      draft([
        { name: 'Aa', weight: 10 },
        { name: 'Bb', weight: 60 },
        { name: 'Cc', weight: 30 },
      ]),
    );
    const analysis = analysisFromBlueprint(blueprint);
    expect(analysis.roleTitle).toBe('Backend Engineer');
    expect(analysis.skills.map((s) => s.name)).toEqual(['Bb', 'Cc', 'Aa']);
    expect(analysis.skills.every((s) => s.sources.join() === 'ROLE' && !s.inResume)).toBe(true);
  });

  it('prefers focus skills when the blueprint lists them', () => {
    const blueprint = BlueprintContent.parse({
      ...normalizeBlueprintDraft(draft([{}, {}, {}])),
      focusSkills: [{ name: 'Node.js', weight: 40, source: 'ROLE' }],
    });
    expect(analysisFromBlueprint(blueprint).skills.map((s) => s.name)).toEqual(['Node.js']);
  });
});
