import { sampleFromJsonSchema, toJsonSchema, type LlmAdapter, type OcrAdapter } from '@cbi/ai-core';

export const MOCK_MODEL_ID = 'mock-llm' as const;
export const MOCK_OCR_MODEL_ID = 'mock-ocr' as const;

/**
 * What the mock "reads" from any scanned document: long enough to pass the
 * scanned-PDF threshold, and clearly labelled so it is never mistaken for a
 * real resume.
 */
export const MOCK_OCR_TEXT = [
  '[mock] OCR text for a scanned document (development only).',
  'Summary: Backend engineer with 4 years of experience building REST APIs.',
  'Experience: Example Company (2021 - present). Built services with Node.js, TypeScript and PostgreSQL.',
  'Skills: Node.js, TypeScript, PostgreSQL, Docker, AWS.',
  'Education: B.Tech Computer Science, 2020.',
].join('\n');

/** DEVELOPMENT/TEST ONLY: returns MOCK_OCR_TEXT for any document (registered with the mock LLM). */
export function createMockOcrAdapter(): OcrAdapter {
  return {
    providerKey: 'mock',
    async recognize({ request, signal }) {
      signal.throwIfAborted();
      return {
        text: MOCK_OCR_TEXT,
        servedModel: MOCK_OCR_MODEL_ID,
        finishReason: 'stop',
        usage: {
          inputTokens: estimateTokens(request.messages.map((m) => m.content).join('')),
          cachedInputTokens: 0,
          outputTokens: estimateTokens(MOCK_OCR_TEXT),
          requests: 1,
        },
      };
    },
  };
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * DEVELOPMENT/TEST ONLY. Deterministic, clearly labelled output: text replies
 * start with "[mock]" and structured replies are schema-valid samples whose
 * strings start with "[mock]". The container only registers this adapter
 * when APP_ENV is development/test AND AI_MOCK_MODE=true; environment
 * validation refuses AI_MOCK_MODE in staging and production.
 */
export function createMockLlmAdapter(): LlmAdapter {
  return {
    providerKey: 'mock',
    async generate({ request, signal }) {
      signal.throwIfAborted();
      const lastUser =
        [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const text = request.output
        ? JSON.stringify(sampleFromJsonSchema(toJsonSchema(request.output.schema)))
        : `[mock] Deterministic reply (${lastUser.length} characters of input).`;
      return {
        text,
        servedModel: MOCK_MODEL_ID,
        finishReason: 'stop',
        usage: {
          inputTokens: estimateTokens(request.messages.map((m) => m.content).join('')),
          cachedInputTokens: 0,
          outputTokens: estimateTokens(text),
          requests: 1,
        },
      };
    },
  };
}
