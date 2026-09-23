import {
  toJsonSchema,
  type FinishReason,
  type LlmAdapter,
  type ProviderCredentials,
} from '@cbi/ai-core';
import { ApiError, FinishReason as GeminiFinish, GoogleGenAI } from '@google/genai';
import { splitSystem, toProviderError } from './shared.js';

type GeminiClient = Pick<GoogleGenAI, 'models'>;

export interface GeminiAdapterOptions {
  /** Injected in tests. Production builds a client per call from the decrypted key. */
  clientFactory?: (credentials: ProviderCredentials, timeoutMs: number) => GeminiClient;
}

const REFUSALS = new Set<string>([
  GeminiFinish.SAFETY,
  GeminiFinish.RECITATION,
  GeminiFinish.BLOCKLIST,
  GeminiFinish.PROHIBITED_CONTENT,
  GeminiFinish.SPII,
]);

function defaultClient(credentials: ProviderCredentials, timeoutMs: number): GeminiClient {
  return new GoogleGenAI({
    apiKey: credentials.apiKey,
    httpOptions: {
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      timeout: timeoutMs,
      // The SDK retries 5 times by default; the router owns retries and fallback.
      retryOptions: { attempts: 1 },
    },
  });
}

/** Gemini via the official Google Gen AI SDK (Gemini Developer API). */
export function createGeminiLlmAdapter(opts: GeminiAdapterOptions = {}): LlmAdapter {
  const factory = opts.clientFactory ?? defaultClient;
  return {
    providerKey: 'gemini',
    async generate({ model, request, credentials, signal }) {
      const client = factory(credentials, model.params.timeoutMs);
      const { system, turns } = splitSystem(request.messages);
      try {
        const response = await client.models.generateContent({
          model: model.modelId,
          contents: turns.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          config: {
            abortSignal: signal,
            ...(system ? { systemInstruction: system } : {}),
            maxOutputTokens: request.maxOutputTokens ?? model.params.maxOutputTokens,
            ...(model.params.temperature !== null ? { temperature: model.params.temperature } : {}),
            ...(request.output
              ? {
                  responseMimeType: 'application/json',
                  responseJsonSchema: toJsonSchema(request.output.schema),
                }
              : {}),
          },
        });
        const finish = response.candidates?.[0]?.finishReason;
        const finishReason: FinishReason =
          response.promptFeedback?.blockReason || (finish && REFUSALS.has(finish))
            ? 'refusal'
            : finish === GeminiFinish.MAX_TOKENS
              ? 'length'
              : finish === GeminiFinish.STOP
                ? 'stop'
                : 'other';
        const usage = response.usageMetadata;
        return {
          text: response.text ?? '',
          servedModel: response.modelVersion ?? model.modelId,
          finishReason,
          usage: {
            inputTokens: usage?.promptTokenCount ?? 0,
            cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
            // Thinking tokens are billed as output.
            outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
            requests: 1,
          },
        };
      } catch (err) {
        throw toProviderError(
          'gemini',
          err,
          err instanceof ApiError ? err.status : undefined,
          signal,
        );
      }
    },
  };
}
