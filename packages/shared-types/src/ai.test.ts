import { describe, expect, it } from 'vitest';
import {
  AddAiModelPriceBody,
  AiModelParams,
  UpdateAiModelBody,
  AI_FEATURE_CAPABILITY,
  AiFeature,
  CreatePromptVersionBody,
  DecimalPrice,
  UpsertAiRouteBody,
} from './ai.js';

describe('DecimalPrice', () => {
  it('converts decimal strings to integer micro-units without float error', () => {
    expect(DecimalPrice.parse('5')).toBe(5_000_000);
    expect(DecimalPrice.parse('0.15')).toBe(150_000);
    expect(DecimalPrice.parse('0.000001')).toBe(1);
    expect(DecimalPrice.parse('12.345678')).toBe(12_345_678);
    // 0.1 + 0.2 style float drift must not appear.
    expect(DecimalPrice.parse('0.3')).toBe(300_000);
  });

  it('rejects negative, over-precise and non-numeric input', () => {
    for (const bad of ['-1', '0.0000001', 'abc', '1e3', '']) {
      expect(DecimalPrice.safeParse(bad).success).toBe(false);
    }
  });
});

describe('AI contracts', () => {
  it('maps every feature to a capability', () => {
    expect(Object.keys(AI_FEATURE_CAPABILITY).sort()).toEqual([...AiFeature.options].sort());
  });

  it('refuses duplicate models in a route chain', () => {
    const result = UpsertAiRouteBody.safeParse({
      active: true,
      chain: [
        { modelId: 'a', priority: 0 },
        { modelId: 'a', priority: 1 },
      ],
      reason: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('model parameter patches never fill in defaults for absent fields', () => {
    expect(UpdateAiModelBody.parse({ params: { concurrency: 5 } }).params).toEqual({
      concurrency: 5,
    });
    expect(AiModelParams.parse({})).toMatchObject({
      timeoutMs: 60_000,
      retries: 1,
      temperature: null,
    });
  });

  it('requires a reason for price changes', () => {
    expect(AddAiModelPriceBody.safeParse({ unit: 'PER_REQUEST', price: '1' }).success).toBe(false);
  });

  it('validates prompt keys', () => {
    const body = { feature: 'interview.question', messages: [{ role: 'system', content: 'x' }] };
    expect(CreatePromptVersionBody.safeParse({ ...body, key: 'interview.question' }).success).toBe(
      true,
    );
    expect(CreatePromptVersionBody.safeParse({ ...body, key: 'Interview Question' }).success).toBe(
      false,
    );
  });
});
