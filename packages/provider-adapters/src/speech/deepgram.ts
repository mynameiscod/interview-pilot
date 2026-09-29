import type { SttAdapter } from '@cbi/ai-core';
import { createDeepgramLiveAdapter, type WebSocketFactory } from './deepgram-live.js';
import { baseMime, speechFetch, speechJson, type FetchLike } from './http.js';

interface DeepgramResponse {
  metadata?: { duration?: number; model_info?: Record<string, { name?: string }> };
  results?: {
    channels?: {
      detected_language?: string;
      alternatives?: { transcript?: string; confidence?: number }[];
    }[];
  };
}

/**
 * Deepgram pre-recorded transcription (`POST /v1/listen`). A language hint is
 * passed when the interview has one; otherwise Deepgram detects it. A
 * language the model does not support fails with 400, which the router
 * treats as "try the next model". `openStream` is live transcription
 * (realtime voice, see deepgram-live.ts).
 */
export function createDeepgramSttAdapter(
  opts: { fetchImpl?: FetchLike; webSocket?: WebSocketFactory } = {},
): SttAdapter {
  const live = createDeepgramLiveAdapter({ webSocket: opts.webSocket });
  return {
    providerKey: 'deepgram',
    openStream: (input) => live.openStream(input),
    async transcribe({ model, request, credentials, signal }) {
      const base = (credentials.baseUrl ?? 'https://api.deepgram.com').replace(/\/$/, '');
      const params = new URLSearchParams({
        model: model.modelId,
        smart_format: 'true',
        punctuate: 'true',
      });
      if (request.language) params.set('language', request.language);
      else params.set('detect_language', 'true');
      const res = await speechFetch(
        'deepgram',
        `${base}/v1/listen?${params}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${credentials.apiKey}`,
            'Content-Type': baseMime(request.mimeType),
          },
          body: request.audio,
        },
        signal,
        opts.fetchImpl,
      );
      const body = await speechJson<DeepgramResponse>('deepgram', res);
      const channel = body.results?.channels?.[0];
      const best = channel?.alternatives?.[0];
      return {
        text: (best?.transcript ?? '').trim(),
        language: channel?.detected_language ?? request.language,
        confidence: typeof best?.confidence === 'number' ? best.confidence : null,
        durationSec: typeof body.metadata?.duration === 'number' ? body.metadata.duration : null,
        servedModel: null,
      };
    },
  };
}
