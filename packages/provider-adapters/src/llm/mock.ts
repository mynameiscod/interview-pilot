import { sampleFromJsonSchema, toJsonSchema, type LlmAdapter } from '@cbi/ai-core';

export const MOCK_MODEL_ID = 'mock-llm' as const;

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
