import type { SttAdapter, TtsAdapter } from '@cbi/ai-core';
import {
  audioExtension,
  baseMime,
  speechBytes,
  speechFetch,
  speechJson,
  type FetchLike,
} from './http.js';

const DEFAULT_VOICE = 'alloy';
const INTERVIEWER_STYLE =
  'Speak as a calm, friendly and professional interviewer, at a moderate pace with clear pronunciation.';

const apiBase = (baseUrl: string | undefined) =>
  (baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');

/** OpenAI transcription (`POST /v1/audio/transcriptions`, e.g. gpt-4o-mini-transcribe). */
export function createOpenAiSttAdapter(opts: { fetchImpl?: FetchLike } = {}): SttAdapter {
  return {
    providerKey: 'openai',
    async transcribe({ model, request, credentials, signal }) {
      const form = new FormData();
      const mime = baseMime(request.mimeType);
      form.append(
        'file',
        new Blob([request.audio as Uint8Array<ArrayBuffer>], { type: mime }),
        `answer.${audioExtension(mime)}`,
      );
      form.append('model', model.modelId);
      form.append('response_format', 'json');
      if (request.language) form.append('language', request.language);
      const res = await speechFetch(
        'openai',
        `${apiBase(credentials.baseUrl)}/audio/transcriptions`,
        { method: 'POST', headers: { Authorization: `Bearer ${credentials.apiKey}` }, body: form },
        signal,
        opts.fetchImpl,
      );
      const body = await speechJson<{
        text?: string;
        language?: string;
        usage?: { type?: string; seconds?: number };
      }>('openai', res);
      return {
        text: (body.text ?? '').trim(),
        language: body.language ?? request.language,
        confidence: null,
        durationSec:
          body.usage?.type === 'duration' && typeof body.usage.seconds === 'number'
            ? body.usage.seconds
            : null,
        servedModel: null,
      };
    },
  };
}

/** OpenAI speech (`POST /v1/audio/speech`), MP3 output. */
export function createOpenAiTtsAdapter(opts: { fetchImpl?: FetchLike } = {}): TtsAdapter {
  return {
    providerKey: 'openai',
    async synthesize({ model, request, credentials, signal }) {
      const res = await speechFetch(
        'openai',
        `${apiBase(credentials.baseUrl)}/audio/speech`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: model.modelId,
            input: request.text,
            voice: model.params.voice ?? DEFAULT_VOICE,
            response_format: 'mp3',
            // Older tts-1 models ignore style instructions; gpt-4o-mini-tts follows them.
            ...(model.modelId.startsWith('tts-1') ? {} : { instructions: INTERVIEWER_STYLE }),
          }),
        },
        signal,
        opts.fetchImpl,
      );
      return { audio: await speechBytes('openai', res), mimeType: 'audio/mpeg', servedModel: null };
    },
  };
}
