import type { TtsAdapter } from '@cbi/ai-core';
import { speechBytes, speechFetch, type FetchLike } from './http.js';

/** ElevenLabs' stock "Rachel" voice; admins set another voice id in the model's params. */
export const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

/**
 * ElevenLabs text-to-speech (`POST /v1/text-to-speech/{voice}`), MP3 output.
 * The language code is sent for models that accept it (Flash/Turbo v2.5).
 */
export function createElevenLabsTtsAdapter(opts: { fetchImpl?: FetchLike } = {}): TtsAdapter {
  return {
    providerKey: 'elevenlabs',
    async synthesize({ model, request, credentials, signal }) {
      const base = (credentials.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '');
      const voice = encodeURIComponent(model.params.voice ?? ELEVENLABS_DEFAULT_VOICE);
      const res = await speechFetch(
        'elevenlabs',
        `${base}/v1/text-to-speech/${voice}?output_format=mp3_44100_64`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': credentials.apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text: request.text,
            model_id: model.modelId,
            ...(request.language && model.modelId.includes('v2_5')
              ? { language_code: request.language }
              : {}),
          }),
        },
        signal,
        opts.fetchImpl,
      );
      return {
        audio: await speechBytes('elevenlabs', res),
        mimeType: 'audio/mpeg',
        servedModel: null,
      };
    },
  };
}
