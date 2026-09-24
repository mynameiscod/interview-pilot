import { AiProviderError, type SttAdapter, type TtsAdapter } from '@cbi/ai-core';

/**
 * DEVELOPMENT/TEST ONLY speech mocks (registered with AI_MOCK_MODE, like the
 * mock LLM).
 *
 * STT: a recording whose bytes start with `MOCK-SPEECH:` transcribes to the
 * text after the prefix. This lets tests and scripts "speak" a real answer.
 * `MOCK-SPEECH-FAIL` simulates a provider outage. Any other audio (a real
 * microphone in development) transcribes to a labelled placeholder.
 *
 * TTS: a short, quiet WAV chime followed by silence roughly as long as
 * reading the text, so the room's speaking indicator behaves realistically.
 */
export const MOCK_SPEECH_PREFIX = 'MOCK-SPEECH:';
export const MOCK_SPEECH_FAIL = 'MOCK-SPEECH-FAIL';

/** Test helper: audio bytes the mock STT transcribes to `text`. */
export const mockSpeech = (text: string) =>
  new TextEncoder().encode(`${MOCK_SPEECH_PREFIX}${text}`);

export function createMockSttAdapter(): SttAdapter {
  return {
    providerKey: 'mock',
    async transcribe({ request }) {
      const head = new TextDecoder().decode(request.audio.subarray(0, 4096));
      if (head.startsWith(MOCK_SPEECH_FAIL)) {
        throw new AiProviderError('mock', 'PROVIDER_ERROR', 'mock_failure', 'simulated outage');
      }
      const spoken = head.startsWith(MOCK_SPEECH_PREFIX)
        ? new TextDecoder().decode(request.audio).slice(MOCK_SPEECH_PREFIX.length).trim()
        : null;
      const seconds = Math.round(request.durationSec ?? 0);
      return {
        text: spoken ?? `[mock] Spoken answer of about ${seconds} seconds.`,
        language: request.language ?? 'en',
        confidence: spoken?.includes('[unclear]') ? 0.3 : 0.99,
        durationSec: request.durationSec,
        servedModel: 'mock-stt',
      };
    },
  };
}

const SAMPLE_RATE = 16_000;

/** 16-bit mono PCM WAV: a 250 ms fading chime, then silence (capped at 8 s in total). */
export function mockSpeechWav(text: string): Uint8Array {
  const seconds = Math.min(8, Math.max(1, text.length * 0.05));
  const samples = Math.round(seconds * SAMPLE_RATE);
  const buf = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  const chime = Math.round(0.25 * SAMPLE_RATE);
  for (let i = 0; i < Math.min(chime, samples); i++) {
    const fade = 1 - i / chime;
    const value = Math.sin((2 * Math.PI * 660 * i) / SAMPLE_RATE) * 0.15 * fade;
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return new Uint8Array(buf);
}

export function createMockTtsAdapter(): TtsAdapter {
  return {
    providerKey: 'mock',
    async synthesize({ request }) {
      return { audio: mockSpeechWav(request.text), mimeType: 'audio/wav', servedModel: 'mock-tts' };
    },
  };
}
