import { sampleFromJsonSchema, toJsonSchema } from '@cbi/ai-core';
import {
  BlueprintContent,
  BlueprintDraftAi,
  JdStructured,
  ResumeStructured,
  RoleAnalysisAi,
} from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { normalizeBlueprintDraft } from './blueprint.js';

/** The development mock provider answers with schema samples; Phase 3 flows must accept them. */
describe('mock provider output for Phase 3 features', () => {
  it.each([
    ['resume.structure', ResumeStructured],
    ['jd.structure', JdStructured],
    ['role.analyze', RoleAnalysisAi],
    ['blueprint.generate', BlueprintDraftAi],
  ] as const)('%s sample validates', (_feature, schema) => {
    const result = schema.safeParse(sampleFromJsonSchema(toJsonSchema(schema)));
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('a sampled blueprint draft normalises into valid BlueprintContent', () => {
    const draft = BlueprintDraftAi.parse(sampleFromJsonSchema(toJsonSchema(BlueprintDraftAi)));
    expect(BlueprintContent.safeParse(normalizeBlueprintDraft(draft)).success).toBe(true);
  });
});
