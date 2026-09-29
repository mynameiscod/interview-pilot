import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  AiProviderError,
  type FinishReason,
  type LlmAdapter,
  type LlmCallInput,
  type LlmCallResult,
  type OcrAdapter,
  type OcrCallInput,
  type ProviderCredentials,
  type UsageUnits,
} from '@cbi/ai-core';
import { effortSupported, samplingParamsSupported } from '@cbi/shared-types';
import {
  attachToLastUser,
  OCR_DEFAULT_INSTRUCTION,
  splitSystem,
  toProviderError,
} from './shared.js';

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
 * if the whole call fails. Covers Opus 5 / 5.5, Fable 5 / 5.1, Mythos 5.1
 * and Sonnet 5.5 (not Sonnet 5).
 */
export const SERVER_FALLBACK_MODELS = /^claude-(opus-5|fable-5|mythos-5-1|sonnet-5-5)/;
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

/** The request body shared by `generate` and `stream`. */
function buildParams({ model, request }: Pick<LlmCallInput, 'model' | 'request'>) {
  const { system, turns } = splitSystem(request.messages);
  const serverFallback = SERVER_FALLBACK_MODELS.test(model.modelId);
  // Sampling parameters are a 400 on current Claude models: a stale admin
  // setting must not take the whole chain down, so it is dropped here too.
  const temperature =
    model.params.temperature !== null && samplingParamsSupported('anthropic', model.modelId)
      ? model.params.temperature
      : null;
  const effort =
    request.effort && effortSupported('anthropic', model.modelId) ? request.effort : null;
  const outputConfig = {
    ...(request.output ? { format: zodOutputFormat(request.output.schema) } : {}),
    ...(effort ? { effort } : {}),
  };
  return {
    model: model.modelId,
    max_tokens: request.maxOutputTokens ?? model.params.maxOutputTokens,
    // The system prompt is the stable prefix (instructions, rubric): cache it.
    // Prefixes below the model's minimum cacheable size are simply not cached.
    ...(system
      ? {
          system: [
            { type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } },
          ],
        }
      : {}),
    messages: turns.map((m) => ({ role: m.role, content: m.content })),
    ...(temperature !== null ? { temperature } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(serverFallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };
}

function usageOf(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): UsageUnits {
  // input_tokens counts only the uncached part; reads and writes are billed at their own rates.
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: usage.output_tokens,
    requests: 1,
  };
}

function resultOf(response: Pick<BetaMessage, 'content' | 'model' | 'stop_reason' | 'usage'>) {
  return {
    text: response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    servedModel: response.model,
    finishReason: FINISH[response.stop_reason ?? ''] ?? 'other',
    usage: usageOf(response.usage),
  } satisfies LlmCallResult;
}

function mapError(err: unknown, signal: AbortSignal): AiProviderError {
  if (
    err instanceof Anthropic.APIUserAbortError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new AiProviderError('anthropic', 'TIMEOUT', 'timeout', 'request timed out', {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiProviderError('anthropic', 'NETWORK_ERROR', 'network', 'connection failed', {
      cause: err,
    });
  }
  return toProviderError(
    'anthropic',
    err,
    err instanceof Anthropic.APIError ? err.status : undefined,
    signal,
  );
}

/** Claude via the official Anthropic SDK (Messages API). */
export function createAnthropicLlmAdapter(opts: AnthropicAdapterOptions = {}): LlmAdapter {
  const factory = opts.clientFactory ?? defaultClient;
  return {
    providerKey: 'anthropic',
    async generate({ model, request, credentials, signal }) {
      const client = factory(credentials, model.params.timeoutMs);
      try {
        const response = await client.beta.messages.create(buildParams({ model, request }), {
          signal,
        });
        return resultOf(response);
      } catch (err) {
        throw mapError(err, signal);
      }
    },

    async *stream({ model, request, credentials, signal }) {
      const client = factory(credentials, model.params.timeoutMs);
      let events: AsyncIterable<BetaRawMessageStreamEvent>;
      try {
        events = await client.beta.messages.create(
          { ...buildParams({ model, request }), stream: true },
          { signal },
        );
      } catch (err) {
        throw mapError(err, signal);
      }
      let text = '';
      let servedModel: string | null = null;
      let stopReason: string | null = null;
      let usage = { input_tokens: 0, output_tokens: 0 } as Parameters<typeof usageOf>[0];
      try {
        for await (const event of events) {
          switch (event.type) {
            case 'message_start':
              servedModel = event.message.model;
              usage = { ...event.message.usage };
              break;
            case 'content_block_delta':
              if (event.delta.type === 'text_delta' && event.delta.text) {
                text += event.delta.text;
                yield { type: 'delta', text: event.delta.text };
              }
              break;
            case 'message_delta':
              stopReason = event.delta.stop_reason ?? stopReason;
              usage = { ...usage, output_tokens: event.usage.output_tokens };
              break;
            default:
              break;
          }
        }
      } catch (err) {
        throw mapError(err, signal);
      }
      yield {
        type: 'done',
        result: {
          text,
          servedModel,
          finishReason: FINISH[stopReason ?? ''] ?? 'other',
          usage: usageOf(usage),
        },
      };
    },
  };
}

function ocrParams({ model, request }: Pick<OcrCallInput, 'model' | 'request'>) {
  const { system, turns } = splitSystem(request.messages);
  const data = Buffer.from(request.document).toString('base64');
  return {
    model: model.modelId,
    max_tokens: request.maxOutputTokens ?? model.params.maxOutputTokens,
    ...(system ? { system } : {}),
    messages: attachToLastUser(turns, (text) => [
      {
        type: 'document' as const,
        source: { type: 'base64' as const, media_type: 'application/pdf' as const, data },
      },
      { type: 'text' as const, text: text || OCR_DEFAULT_INSTRUCTION },
    ]),
    ...(SERVER_FALLBACK_MODELS.test(model.modelId)
      ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const }
      : {}),
  };
}

/**
 * OCR for scanned PDFs through Claude's PDF input: a base64 `document` block
 * placed before the instruction text (up to 32 MB per request, far above the
 * upload cap). Each page is read as text and as an image, so image-only
 * pages are recognised.
 */
export function createAnthropicOcrAdapter(opts: AnthropicAdapterOptions = {}): OcrAdapter {
  const factory = opts.clientFactory ?? defaultClient;
  return {
    providerKey: 'anthropic',
    async recognize({ model, request, credentials, signal }) {
      const client = factory(credentials, model.params.timeoutMs);
      try {
        const response = await client.beta.messages.create(ocrParams({ model, request }), {
          signal,
        });
        return resultOf(response);
      } catch (err) {
        throw mapError(err, signal);
      }
    },
  };
}
