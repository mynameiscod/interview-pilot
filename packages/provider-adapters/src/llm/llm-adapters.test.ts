import Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, type LlmCallInput } from '@cbi/ai-core';
import { ApiError } from '@google/genai';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAnthropicLlmAdapter } from './anthropic.js';
import { createGeminiLlmAdapter } from './gemini.js';
import { createMockLlmAdapter } from './mock.js';
import { createOpenAiLlmAdapter } from './openai.js';

const Answer = z.object({ score: z.number().int().min(0).max(100), rationale: z.string() });

function input(modelId: string, overrides: Partial<LlmCallInput> = {}): LlmCallInput {
  return {
    model: {
      providerKey: 'anthropic',
      modelId,
      params: {
        temperature: null,
        maxOutputTokens: 2048,
        timeoutMs: 30_000,
        retries: 1,
        concurrency: 5,
      },
    },
    request: {
      messages: [
        { role: 'system', content: 'You are an interviewer.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Score me' },
      ],
      maxOutputTokens: 1000,
    },
    credentials: { apiKey: 'sk-test' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

const withOutput = (base: LlmCallInput): LlmCallInput => ({
  ...base,
  request: { ...base.request, output: { name: 'answer', schema: Answer } },
});

async function expectOutcome(promise: Promise<unknown>, outcome: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AiProviderError);
  expect((err as AiProviderError).outcome).toBe(outcome);
}

describe('Anthropic adapter', () => {
  function fake(response: unknown | Error) {
    const calls: { params: Record<string, unknown>; options: unknown }[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>, options: unknown) => {
            calls.push({ params, options });
            if (response instanceof Error) throw response;
            return response;
          },
        },
      },
    } as unknown as Pick<Anthropic, 'beta'>;
    const creds: unknown[] = [];
    const adapter = createAnthropicLlmAdapter({
      clientFactory: (c, timeoutMs) => {
        creds.push({ ...c, timeoutMs });
        return client;
      },
    });
    return { adapter, calls, creds };
  }

  const message = {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '{"score":80,' },
      { type: 'text', text: '"rationale":"clear"}' },
    ],
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 50,
      output_tokens: 30,
    },
  };

  it('maps messages, structured output and server-side refusal fallbacks', async () => {
    const t = fake(message);
    const result = await t.adapter.generate(withOutput(input('claude-opus-5')));
    const params = t.calls[0]!.params;
    expect(params).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 1000,
      system: 'You are an interviewer.',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Score me' },
      ],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect((params.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    expect(params).not.toHaveProperty('temperature');
    expect(t.creds[0]).toEqual({ apiKey: 'sk-test', timeoutMs: 30_000 });
    expect(result).toEqual({
      text: '{"score":80,"rationale":"clear"}',
      servedModel: 'claude-opus-5',
      finishReason: 'stop',
      usage: { inputTokens: 550, cachedInputTokens: 400, outputTokens: 30, requests: 1 },
    });
  });

  it('omits server fallbacks for models that do not support them and sends temperature when configured', async () => {
    const t = fake({ ...message, model: 'claude-haiku-4-5' });
    const base = input('claude-haiku-4-5');
    await t.adapter.generate({
      ...base,
      model: { ...base.model, params: { ...base.model.params, temperature: 0.2 } },
    });
    expect(t.calls[0]!.params).not.toHaveProperty('fallbacks');
    expect(t.calls[0]!.params).not.toHaveProperty('output_config');
    expect(t.calls[0]!.params.temperature).toBe(0.2);
  });

  it('reports refusals and truncation', async () => {
    expect(
      (await fake({ ...message, stop_reason: 'refusal' }).adapter.generate(input('claude-opus-5')))
        .finishReason,
    ).toBe('refusal');
    expect(
      (
        await fake({ ...message, stop_reason: 'max_tokens' }).adapter.generate(
          input('claude-opus-5'),
        )
      ).finishReason,
    ).toBe('length');
  });

  it('classifies SDK errors', async () => {
    const gen = (status: number) =>
      Anthropic.APIError.generate(status, { error: { type: 'x' } }, 'boom', new Headers());
    await expectOutcome(fake(gen(429)).adapter.generate(input('claude-opus-5')), 'RATE_LIMITED');
    await expectOutcome(fake(gen(529)).adapter.generate(input('claude-opus-5')), 'PROVIDER_ERROR');
    await expectOutcome(fake(gen(401)).adapter.generate(input('claude-opus-5')), 'AUTH_ERROR');
    await expectOutcome(fake(gen(400)).adapter.generate(input('claude-opus-5')), 'BAD_REQUEST');
    await expectOutcome(
      fake(new Anthropic.APIConnectionError({ message: 'down' })).adapter.generate(
        input('claude-opus-5'),
      ),
      'NETWORK_ERROR',
    );
    await expectOutcome(
      fake(new Anthropic.APIConnectionTimeoutError()).adapter.generate(input('claude-opus-5')),
      'TIMEOUT',
    );
  });
});

describe('OpenAI adapter', () => {
  function fake(response: unknown | Error) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          if (response instanceof Error) throw response;
          return response;
        },
      },
    } as unknown as Pick<OpenAI, 'responses'>;
    return { adapter: createOpenAiLlmAdapter({ clientFactory: () => client }), calls };
  }

  const response = {
    model: 'gpt-5.1-2026-01-01',
    status: 'completed',
    incomplete_details: null,
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    output_text: 'hi',
    usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 50 }, output_tokens: 10 },
  };

  it('maps instructions, input, JSON schema format and never stores responses', async () => {
    const t = fake(response);
    const result = await t.adapter.generate(withOutput(input('gpt-5.1')));
    expect(t.calls[0]).toMatchObject({
      model: 'gpt-5.1',
      instructions: 'You are an interviewer.',
      max_output_tokens: 1000,
      store: false,
      text: { format: { type: 'json_schema', name: 'answer', strict: false } },
    });
    expect(t.calls[0]!.input).toHaveLength(3);
    expect(result.usage).toEqual({
      inputTokens: 200,
      cachedInputTokens: 50,
      outputTokens: 10,
      requests: 1,
    });
    expect(result.servedModel).toBe('gpt-5.1-2026-01-01');
  });

  it('detects refusals and truncation', async () => {
    const refusal = {
      ...response,
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
    };
    expect((await fake(refusal).adapter.generate(input('gpt-5.1'))).finishReason).toBe('refusal');
    const truncated = {
      ...response,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    };
    expect((await fake(truncated).adapter.generate(input('gpt-5.1'))).finishReason).toBe('length');
  });

  it('classifies SDK errors', async () => {
    const gen = (status: number) =>
      OpenAI.APIError.generate(status, { error: {} }, 'boom', new Headers());
    await expectOutcome(fake(gen(429)).adapter.generate(input('gpt-5.1')), 'RATE_LIMITED');
    await expectOutcome(fake(gen(503)).adapter.generate(input('gpt-5.1')), 'PROVIDER_ERROR');
    await expectOutcome(fake(gen(403)).adapter.generate(input('gpt-5.1')), 'AUTH_ERROR');
    await expectOutcome(
      fake(new OpenAI.APIConnectionTimeoutError()).adapter.generate(input('gpt-5.1')),
      'TIMEOUT',
    );
  });
});

describe('Gemini adapter', () => {
  function fake(response: unknown | Error) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      models: {
        generateContent: async (params: Record<string, unknown>) => {
          calls.push(params);
          if (response instanceof Error) throw response;
          return response;
        },
      },
    };
    return {
      adapter: createGeminiLlmAdapter({ clientFactory: () => client as never }),
      calls,
    };
  }

  const response = {
    text: '{"score":1,"rationale":"x"}',
    modelVersion: 'gemini-3-pro',
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 300,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 80,
    },
  };

  it('maps roles, system instruction and JSON output; counts thinking tokens as output', async () => {
    const t = fake(response);
    const result = await t.adapter.generate(withOutput(input('gemini-3-pro')));
    const params = t.calls[0] as { contents: { role: string }[]; config: Record<string, unknown> };
    expect(params.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(params.config).toMatchObject({
      systemInstruction: 'You are an interviewer.',
      maxOutputTokens: 1000,
      responseMimeType: 'application/json',
    });
    expect(params.config.responseJsonSchema).toHaveProperty('properties.score');
    expect(result.usage.outputTokens).toBe(100);
    expect(result.finishReason).toBe('stop');
  });

  it('reports safety blocks as refusals', async () => {
    const blocked = {
      ...response,
      text: undefined,
      candidates: [],
      promptFeedback: { blockReason: 'SAFETY' },
    };
    expect((await fake(blocked).adapter.generate(input('gemini-3-pro'))).finishReason).toBe(
      'refusal',
    );
  });

  it('classifies API errors and network failures', async () => {
    await expectOutcome(
      fake(new ApiError({ status: 429, message: 'quota' })).adapter.generate(input('gemini-3-pro')),
      'RATE_LIMITED',
    );
    await expectOutcome(
      fake(new TypeError('fetch failed')).adapter.generate(input('gemini-3-pro')),
      'NETWORK_ERROR',
    );
  });
});

describe('mock adapter', () => {
  it('is deterministic, labelled and schema-valid', async () => {
    const adapter = createMockLlmAdapter();
    const a = await adapter.generate(withOutput(input('mock-llm')));
    const b = await adapter.generate(withOutput(input('mock-llm')));
    expect(a).toEqual(b);
    expect(Answer.parse(JSON.parse(a.text)).rationale).toMatch(/^\[mock\]/);
    const text = await adapter.generate(input('mock-llm'));
    expect(text.text).toMatch(/^\[mock\]/);
    expect(text.servedModel).toBe('mock-llm');
  });

  it('honours aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createMockLlmAdapter().generate(input('mock-llm', { signal: controller.signal })),
    ).rejects.toThrow();
  });
});
