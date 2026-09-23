import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  AiProviderError,
  type FinishReason,
  type LlmAdapter,
  type ProviderCredentials,
} from '@cbi/ai-core';
import { splitSystem, toProviderError } from './shared.js';

type AnthropicClient = Pick<Anthropic, 'beta'>;

export interface AnthropicAdapterOptions {
  /** Injected in tests. Production builds a client per call from the decrypted key. */
  clientFactory?: (credentials: ProviderCredentials, timeoutMs: number) => AnthropicClient;
}

/**
 * Models that support server-side refusal fallbacks. On a policy decline the
 * API re-runs the request on Anthropic's recommended model for that refusal
 * category inside the same call (`fallbacks: "default"`), so a false
 * positive does not become an outage. The router's own chain still applies
 * if the whole call fails.
 */
const SERVER_FALLBACK_MODELS = /^claude-(opus-5|fable-5)/;
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const FINISH: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  refusal: 'refusal',
};

function defaultClient(credentials: ProviderCredentials, timeoutMs: number): AnthropicClient {
  return new Anthropic({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl,
    // The router owns retries, backoff and fallback.
    maxRetries: 0,
    timeout: timeoutMs,
  });
}

/** Claude via the official Anthropic SDK (Messages API). */
export function createAnthropicLlmAdapter(opts: AnthropicAdapterOptions = {}): LlmAdapter {
  const factory = opts.clientFactory ?? defaultClient;
  return {
    providerKey: 'anthropic',
    async generate({ model, request, credentials, signal }) {
      const client = factory(credentials, model.params.timeoutMs);
      const { system, turns } = splitSystem(request.messages);
      const serverFallback = SERVER_FALLBACK_MODELS.test(model.modelId);
      try {
        const response = await client.beta.messages.create(
          {
            model: model.modelId,
            max_tokens: request.maxOutputTokens ?? model.params.maxOutputTokens,
            ...(system ? { system } : {}),
            messages: turns.map((m) => ({ role: m.role, content: m.content })),
            // Current Claude models reject sampling parameters; only send one when configured.
            ...(model.params.temperature !== null ? { temperature: model.params.temperature } : {}),
            ...(request.output
              ? { output_config: { format: zodOutputFormat(request.output.schema) } }
              : {}),
            ...(serverFallback
              ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const }
              : {}),
          },
          { signal },
        );
        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        const usage = response.usage;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        return {
          text,
          servedModel: response.model,
          finishReason: FINISH[response.stop_reason ?? ''] ?? 'other',
          usage: {
            inputTokens: usage.input_tokens + cacheRead + (usage.cache_creation_input_tokens ?? 0),
            cachedInputTokens: cacheRead,
            outputTokens: usage.output_tokens,
            requests: 1,
          },
        };
      } catch (err) {
        if (
          err instanceof Anthropic.APIUserAbortError ||
          err instanceof Anthropic.APIConnectionTimeoutError
        ) {
          throw new AiProviderError('anthropic', 'TIMEOUT', 'timeout', 'request timed out', {
            cause: err,
          });
        }
        if (err instanceof Anthropic.APIConnectionError) {
          throw new AiProviderError('anthropic', 'NETWORK_ERROR', 'network', 'connection failed', {
            cause: err,
          });
        }
        throw toProviderError(
          'anthropic',
          err,
          err instanceof Anthropic.APIError ? err.status : undefined,
          signal,
        );
      }
    },
  };
}
