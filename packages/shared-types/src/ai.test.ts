import { describe, expect, it } from 'vitest';
import {
  AddAiModelPriceBody,
  AiModelParams,
  UpdateAiModelBody,
  AI_FEATURE_CAPABILITY,
  AiFeature,
  CreatePromptVersionBody,
  DecimalPrice,
  DEFAULT_ROUTE_EFFORT,
  effortSupported,
  samplingParamsSupported,
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

  it('knows which models reject sampling parameters', () => {
    for (const id of [
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-7',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-fable-5-1',
    ]) {
      expect(samplingParamsSupported('anthropic', id)).toBe(false);
    }
    expect(samplingParamsSupported('anthropic', 'claude-haiku-4-5')).toBe(true);
    expect(samplingParamsSupported('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(samplingParamsSupported('openai', 'gpt-5.6-terra')).toBe(false);
    expect(samplingParamsSupported('openai', 'gpt-4.1')).toBe(true);
    expect(samplingParamsSupported('gemini', 'gemini-3.1-pro-preview')).toBe(true);
  });

  it('knows which models take an effort setting', () => {
    expect(effortSupported('anthropic', 'claude-opus-5-5')).toBe(true);
    expect(effortSupported('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(effortSupported('anthropic', 'claude-haiku-4-5')).toBe(false);
    expect(effortSupported('anthropic', 'claude-sonnet-4-5')).toBe(false);
    expect(effortSupported('openai', 'gpt-5.6-terra')).toBe(true);
    expect(effortSupported('gemini', 'gemini-3.1-pro-preview')).toBe(false);
  });

  it('seeds an effort for every LLM feature and accepts effort on route updates', () => {
    const llm = AiFeature.options.filter(
      (f) => AI_FEATURE_CAPABILITY[f] === 'LLM' && f !== 'admin.test',
    );
    expect(llm.every((f) => DEFAULT_ROUTE_EFFORT[f])).toBe(true);
    const base = { active: true, chain: [], reason: 'tune' };
    expect(UpsertAiRouteBody.parse({ ...base, effort: 'high' }).effort).toBe('high');
    expect(UpsertAiRouteBody.parse(base).effort).toBeUndefined();
    expect(UpsertAiRouteBody.safeParse({ ...base, effort: 'max' }).success).toBe(false);
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
