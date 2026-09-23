import {
  AiProviderError,
  toJsonSchema,
  type FinishReason,
  type LlmAdapter,
  type ProviderCredentials,
} from '@cbi/ai-core';
import OpenAI from 'openai';
import { splitSystem, toProviderError } from './shared.js';

type OpenAiClient = Pick<OpenAI, 'responses'>;

export interface OpenAiAdapterOptions {
  /** Injected in tests. Production builds a client per call from the decrypted key. */
  clientFactory?: (credentials: ProviderCredentials, timeoutMs: number) => OpenAiClient;
}

function defaultClient(credentials: ProviderCredentials, timeoutMs: number): OpenAiClient {
  return new OpenAI({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl,
    // The router owns retries, backoff and fallback.
    maxRetries: 0,
    timeout: timeoutMs,
  });
}

/** OpenAI via the official SDK (Responses API). Responses are not stored by OpenAI. */
export function createOpenAiLlmAdapter(opts: OpenAiAdapterOptions = {}): LlmAdapter {
  const factory = opts.clientFactory ?? defaultClient;
  return {
    providerKey: 'openai',
    async generate({ model, request, credentials, signal }) {
      const client = factory(credentials, model.params.timeoutMs);
      const { system, turns } = splitSystem(request.messages);
      try {
        const response = await client.responses.create(
          {
            model: model.modelId,
            ...(system ? { instructions: system } : {}),
            input: turns.map((m) => ({ role: m.role, content: m.content })),
            max_output_tokens: request.maxOutputTokens ?? model.params.maxOutputTokens,
            ...(model.params.temperature !== null ? { temperature: model.params.temperature } : {}),
            ...(request.output
              ? {
                  text: {
                    format: {
                      type: 'json_schema' as const,
                      name: request.output.name,
                      schema: toJsonSchema(request.output.schema),
                      // Strict mode rejects common Zod shapes (optional fields); the router validates instead.
                      strict: false,
                    },
                  },
                }
              : {}),
            store: false,
          },
          { signal },
        );
        const refused = response.output.some(
          (item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
        );
        const reason = response.incomplete_details?.reason;
        const finishReason: FinishReason =
          refused || reason === 'content_filter'
            ? 'refusal'
            : reason === 'max_output_tokens'
              ? 'length'
              : response.status === 'completed'
                ? 'stop'
                : 'other';
        return {
          text: response.output_text,
          servedModel: response.model,
          finishReason,
          usage: {
            inputTokens: response.usage?.input_tokens ?? 0,
            cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
            requests: 1,
          },
        };
      } catch (err) {
        if (
          err instanceof OpenAI.APIUserAbortError ||
          err instanceof OpenAI.APIConnectionTimeoutError
        ) {
          throw new AiProviderError('openai', 'TIMEOUT', 'timeout', 'request timed out', {
            cause: err,
          });
        }
        if (err instanceof OpenAI.APIConnectionError) {
          throw new AiProviderError('openai', 'NETWORK_ERROR', 'network', 'connection failed', {
            cause: err,
          });
        }
        throw toProviderError(
          'openai',
          err,
          err instanceof OpenAI.APIError ? err.status : undefined,
          signal,
        );
      }
    },
  };
}
