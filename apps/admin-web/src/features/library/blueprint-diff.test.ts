import type { BlueprintContent } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { competencyWeightTotal, diffBlueprints, diffKeyed } from './blueprint-diff';
import { blueprintContent } from './test-fixtures';

describe('diffBlueprints', () => {
  it('reports identical content as identical', () => {
    const diff = diffBlueprints(blueprintContent(), blueprintContent());
    expect(diff.identical).toBe(true);
    expect(diff.competencies).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.role).toEqual([]);
    expect(diff.notes).toBeNull();
  });

  it('finds added, removed and changed competencies with field-level changes', () => {
    const base = blueprintContent();
    const target: BlueprintContent = {
      ...base,
      competencies: [
        { ...base.competencies[0]!, weight: 45, roundTypes: ['TECHNICAL', 'CODING'] },
        base.competencies[1]!,
        {
          key: 'system-design',
          name: 'System design',
          category: 'TECHNICAL',
          weight: 25,
          description: '',
          subCompetencies: [],
          expectedEvidence: ['Designs for scale'],
          difficulty: 'HARD',
          roundTypes: ['TECHNICAL'],
        },
      ],
    };
    const diff = diffBlueprints(base, target);
    expect(diff.identical).toBe(false);
    expect(diff.competencies.added.map((c) => c.key)).toEqual(['system-design']);
    expect(diff.competencies.removed.map((c) => c.key)).toEqual(['communication']);
    expect(diff.competencies.changed).toEqual([
      {
        key: 'api-design',
        item: target.competencies[0],
        changes: [
          { field: 'weight', from: 40, to: 45 },
          { field: 'roundTypes', from: 'TECHNICAL', to: 'TECHNICAL, CODING' },
        ],
      },
    ]);
  });

  it('diffs role fields, focus skills, probe areas and notes', () => {
    const base = blueprintContent();
    const target: BlueprintContent = {
      ...base,
      role: { ...base.role, seniority: 'SENIOR' },
      focusSkills: [{ name: 'Node.js', weight: 60, source: 'JD' }],
      probeAreas: [{ topic: 'Kafka', reason: 'Listed on resume', source: 'RESUME' }],
      notes: 'Reviewed',
    };
    const diff = diffBlueprints(base, target);
    expect(diff.role).toEqual([{ field: 'seniority', from: 'MID', to: 'SENIOR' }]);
    expect(diff.focusSkills.changed[0]!.changes).toEqual([{ field: 'weight', from: 50, to: 60 }]);
    expect(diff.probeAreas.added.map((p) => p.topic)).toEqual(['Kafka']);
    expect(diff.notes).toEqual({ field: 'notes', from: '', to: 'Reviewed' });
  });

  it('matches items by key regardless of order', () => {
    const a = [
      { id: 'x', v: 1 },
      { id: 'y', v: 2 },
    ];
    const diff = diffKeyed(a, [...a].reverse(), (i) => i.id, ['v']);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('competencyWeightTotal', () => {
  it('sums weights of possibly-invalid editor content', () => {
    expect(competencyWeightTotal(blueprintContent())).toBe(100);
    expect(competencyWeightTotal({ competencies: [{ weight: 10 }, { weight: 'x' }, {}] })).toBe(10);
    expect(competencyWeightTotal({})).toBeNull();
    expect(competencyWeightTotal(null)).toBeNull();
  });
});
