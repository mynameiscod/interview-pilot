import type { SttAdapter, TtsAdapter, TtsCallInput } from '@cbi/ai-core';
import {
  audioExtension,
  baseMime,
  speechBytes,
  speechChunks,
  speechFetch,
  speechJson,
  timedWords,
  type FetchLike,
} from './http.js';

const DEFAULT_VOICE = 'alloy';
const INTERVIEWER_STYLE =
  'Speak as a calm, friendly and professional interviewer, at a moderate pace with clear pronunciation.';

const apiBase = (baseUrl: string | undefined) =>
  (baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');

/**
 * Models that return word timestamps (`verbose_json` with
 * `timestamp_granularities[]=word`). The gpt-4o transcribe models only accept
 * `json`/`text`, so they give text without timestamps.
 */
export const openAiWordTimestamps = (modelId: string) => modelId.startsWith('whisper');

/** `verbose_json` names the language ("english"); the rest of the platform uses codes. */
const LANGUAGE_CODES: Record<string, string> = { english: 'en', hindi: 'hi', telugu: 'te' };

/**
 * OpenAI transcription (`POST /v1/audio/transcriptions`, e.g.
 * gpt-4o-mini-transcribe). Word timestamps are asked for where the model
 * supports them (whisper-1), for delivery coaching.
 */
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
      const verbose = openAiWordTimestamps(model.modelId);
      form.append('response_format', verbose ? 'verbose_json' : 'json');
      if (verbose) form.append('timestamp_granularities[]', 'word');
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
        duration?: number;
        words?: { word?: string; start?: number; end?: number }[];
      }>('openai', res);
      return {
        text: (body.text ?? '').trim(),
        language: body.language
          ? (LANGUAGE_CODES[body.language.toLowerCase()] ?? body.language)
          : request.language,
        confidence: null,
        durationSec:
          body.usage?.type === 'duration' && typeof body.usage.seconds === 'number'
            ? body.usage.seconds
            : typeof body.duration === 'number'
              ? body.duration
              : null,
        servedModel: null,
        words: timedWords(body.words),
      };
    },
  };
}

/**
 * OpenAI speech (`POST /v1/audio/speech`), MP3 output. `synthesizeStream`
 * reads the same response as it arrives (chunked transfer, `stream_format:
 * audio`), so playback can start before the whole file is generated.
 */
export function createOpenAiTtsAdapter(opts: { fetchImpl?: FetchLike } = {}): TtsAdapter {
  const call = ({ model, request, credentials, signal }: TtsCallInput, stream: boolean) =>
    speechFetch(
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
          ...(stream ? { stream_format: 'audio' } : {}),
          // Older tts-1 models ignore style instructions; gpt-4o-mini-tts follows them.
          ...(model.modelId.startsWith('tts-1') ? {} : { instructions: INTERVIEWER_STYLE }),
        }),
      },
      signal,
      opts.fetchImpl,
    );
  return {
    providerKey: 'openai',
    async synthesize(input) {
      const res = await call(input, false);
      return { audio: await speechBytes('openai', res), mimeType: 'audio/mpeg', servedModel: null };
    },
    async synthesizeStream(input) {
      const res = await call(input, true);
      return { mimeType: 'audio/mpeg', chunks: speechChunks('openai', res) };
    },
  };
}
