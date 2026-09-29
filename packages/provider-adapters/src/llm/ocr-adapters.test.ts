import type Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, type OcrCallInput } from '@cbi/ai-core';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createAnthropicOcrAdapter } from './anthropic.js';
import { createGeminiOcrAdapter } from './gemini.js';
import { createMockOcrAdapter, MOCK_OCR_TEXT } from './mock.js';
import { createOpenAiOcrAdapter } from './openai.js';

const PDF = new Uint8Array(Buffer.from('%PDF-1.4 scanned'));
const B64 = Buffer.from(PDF).toString('base64');

function input(modelId: string): OcrCallInput {
  return {
    model: {
      providerKey: 'anthropic',
      modelId,
      params: {
        temperature: null,
        maxOutputTokens: 8000,
        timeoutMs: 60_000,
        retries: 1,
        concurrency: 5,
      },
    },
    request: {
      document: PDF,
      mimeType: 'application/pdf',
      pages: 2,
      messages: [
        { role: 'system', content: 'You transcribe documents.' },
        { role: 'user', content: 'Transcribe the document.' },
      ],
      maxOutputTokens: 6000,
    },
    credentials: { apiKey: 'sk-test' },
    signal: new AbortController().signal,
  };
}

describe('Anthropic OCR adapter', () => {
  function fake(response: unknown) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            calls.push(params);
            if (response instanceof Error) throw response;
            return response;
          },
        },
      },
    } as unknown as Pick<Anthropic, 'beta'>;
    return { adapter: createAnthropicOcrAdapter({ clientFactory: () => client }), calls };
  }

  it('sends the PDF as a base64 document block before the instruction', async () => {
    const t = fake({
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Priya Sharma\nBackend Engineer' }],
      usage: { input_tokens: 3000, output_tokens: 40 },
    });
    const result = await t.adapter.recognize(input('claude-sonnet-5-5'));
    expect(t.calls[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 6000,
      system: 'You transcribe documents.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: B64 },
            },
            { type: 'text', text: 'Transcribe the document.' },
          ],
        },
      ],
      fallbacks: 'default',
    });
    expect(result).toMatchObject({
      text: 'Priya Sharma\nBackend Engineer',
      finishReason: 'stop',
      usage: { inputTokens: 3000, outputTokens: 40, requests: 1 },
    });
  });

  it('maps provider errors', async () => {
    const t = fake(Object.assign(new Error('boom'), { status: 413 }));
    const err = await t.adapter.recognize(input('claude-haiku-4-5')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
  });
});

describe('Gemini OCR adapter', () => {
  it('sends the PDF as inline data', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      models: {
        generateContent: async (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            text: 'Scanned text',
            modelVersion: 'gemini-3.1-pro',
            candidates: [{ finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30 },
          };
        },
      },
    };
    const adapter = createGeminiOcrAdapter({ clientFactory: () => client as never });
    const result = await adapter.recognize(input('gemini-3.1-pro-preview'));
    expect(calls[0]).toMatchObject({
      model: 'gemini-3.1-pro-preview',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data: B64 } },
            { text: 'Transcribe the document.' },
          ],
        },
      ],
      config: { systemInstruction: 'You transcribe documents.', maxOutputTokens: 6000 },
    });
    expect(result.text).toBe('Scanned text');
  });
});

describe('OpenAI OCR adapter', () => {
  it('sends the PDF as an inline input_file and never stores the response', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            model: 'gpt-5.6-terra',
            status: 'completed',
            incomplete_details: null,
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Read' }] }],
            output_text: 'Read',
            usage: { input_tokens: 900, output_tokens: 5 },
          };
        },
      },
    } as unknown as Pick<OpenAI, 'responses'>;
    const adapter = createOpenAiOcrAdapter({ clientFactory: () => client });
    const result = await adapter.recognize(input('gpt-5.6-terra'));
    expect(calls[0]).toMatchObject({
      instructions: 'You transcribe documents.',
      store: false,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_file',
              filename: 'document.pdf',
              file_data: `data:application/pdf;base64,${B64}`,
            },
            { type: 'input_text', text: 'Transcribe the document.' },
          ],
        },
      ],
    });
    expect(result.text).toBe('Read');
  });
});

describe('mock OCR adapter', () => {
  it('returns labelled text long enough to pass the scanned-PDF threshold', async () => {
    const result = await createMockOcrAdapter().recognize(input('mock-ocr'));
    expect(result.text).toBe(MOCK_OCR_TEXT);
    expect(result.text.startsWith('[mock]')).toBe(true);
    expect(result.text.length).toBeGreaterThan(200);
  });
});
