import {
  AiProviderError,
  type SpeechStream,
  type SpeechStreamEvent,
  type SttAdapter,
  type SttStreamInput,
  type TtsAdapter,
} from '@cbi/ai-core';

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
 *
 * Streaming STT (realtime voice) follows the audio clock, not timers: a
 * frame starting with `MOCK-SPEECH:` is "heard" as its text; real PCM that
 * is loud enough counts as speech and is transcribed to a labelled
 * placeholder once the speaker pauses. Quiet audio after the last word
 * produces the utterance end. Streaming TTS sends the WAV in chunks.
 */
export const MOCK_SPEECH_PREFIX = 'MOCK-SPEECH:';
export const MOCK_SPEECH_FAIL = 'MOCK-SPEECH-FAIL';

/**
 * Test helper: a clip the mock STT transcribes to `text`. It starts with a
 * WAV header so it passes the API's container check, followed by the marker.
 */
export const mockSpeech = (text: string) =>
  new TextEncoder().encode(`RIFF\0\0\0\0WAVE${MOCK_SPEECH_PREFIX}${text}`);

/** A clip that makes the mock STT fail (simulated provider outage). */
export const mockSpeechFailure = () =>
  new TextEncoder().encode(`RIFF\0\0\0\0WAVE${MOCK_SPEECH_FAIL}`);

export function createMockSttAdapter(): SttAdapter {
  return {
    providerKey: 'mock',
    openStream: async (input) => openMockSpeechStream(input),
    async transcribe({ request }) {
      const decoded = new TextDecoder().decode(request.audio);
      if (decoded.slice(0, 64).includes(MOCK_SPEECH_FAIL)) {
        throw new AiProviderError('mock', 'PROVIDER_ERROR', 'mock_failure', 'simulated outage');
      }
      const marker = decoded.slice(0, 64).indexOf(MOCK_SPEECH_PREFIX);
      // Clips padded with zero bytes (to a realistic size) end at the first NUL.
      const spoken =
        marker >= 0
          ? decoded
              .slice(marker + MOCK_SPEECH_PREFIX.length)
              .split('\0')[0]!
              .trim()
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
    async synthesizeStream({ request, signal }) {
      const wav = mockSpeechWav(request.text);
      return {
        mimeType: 'audio/wav',
        chunks: (async function* () {
          const size = Math.ceil(wav.length / 3);
          for (let at = 0; at < wav.length; at += size) {
            signal.throwIfAborted();
            yield wav.subarray(at, at + size);
          }
        })(),
      };
    },
  };
}

/** Peak-normalised RMS above which mock streaming hears speech (quiet rooms are ~0.005). */
const MOCK_SPEECH_RMS = 0.02;
/** A pause this long ends a mock "phrase" (like provider endpointing). */
const MOCK_PHRASE_PAUSE_SEC = 0.3;

function pcmRms(bytes: Uint8Array): number {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength - (bytes.byteLength % 2),
  );
  const samples = view.byteLength / 2;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

/** The mock live transcription session (see the notes at the top of this file). */
export function openMockSpeechStream(input: SttStreamInput): SpeechStream {
  const { request, onEvent } = input;
  const bytesPerSec = request.sampleRate * 2;
  let closed = false;
  let clock = 0;
  let lastWordEnd: number | null = null;
  let utteranceEnded = true;
  /** Real audio being heard: when it started and how much of it was voiced. */
  let phrase: { start: number; voiced: number; lastVoice: number } | null = null;
  const emit = (event: SpeechStreamEvent) => {
    if (!closed) onEvent(event);
  };
  const final = (text: string, start: number, end: number, fromFinalize = false) => {
    emit({
      type: 'transcript',
      text,
      isFinal: true,
      speechFinal: !fromFinalize,
      confidence: text.includes('[unclear]') ? 0.3 : 0.99,
      start,
      duration: Math.max(0, end - start),
    });
    lastWordEnd = end;
    utteranceEnded = false;
  };
  const endPhrase = (fromFinalize = false) => {
    if (!phrase) return;
    const seconds = Math.max(1, Math.round(phrase.voiced));
    final(
      `[mock] Spoken answer of about ${seconds} second${seconds === 1 ? '' : 's'}.`,
      phrase.start,
      phrase.lastVoice,
      fromFinalize,
    );
    phrase = null;
  };
  return {
    send(audio) {
      if (closed) return;
      const text = new TextDecoder().decode(audio.subarray(0, 64));
      if (text.startsWith(MOCK_SPEECH_FAIL)) {
        emit({
          type: 'error',
          error: new AiProviderError('mock', 'PROVIDER_ERROR', 'mock_failure', 'simulated outage'),
        });
        return;
      }
      if (text.startsWith(MOCK_SPEECH_PREFIX)) {
        // A scripted phrase, spoken at 2.5 words a second (at least one second).
        const spoken = new TextDecoder().decode(audio).slice(MOCK_SPEECH_PREFIX.length).trim();
        const words = spoken.split(/\s+/).filter(Boolean);
        const length = Math.max(1, words.length * 0.4);
        emit({ type: 'speech_started', at: clock });
        emit({
          type: 'transcript',
          text: words.slice(0, Math.ceil(words.length / 2)).join(' '),
          isFinal: false,
          speechFinal: false,
          confidence: null,
          start: clock,
          duration: 0.5,
        });
        final(spoken, clock, clock + length);
        clock += length;
        return;
      }
      const seconds = audio.byteLength / bytesPerSec;
      const voiced = pcmRms(audio) >= MOCK_SPEECH_RMS;
      if (voiced) {
        if (!phrase) {
          phrase = { start: clock, voiced: 0, lastVoice: clock };
          emit({ type: 'speech_started', at: clock });
        }
        phrase.voiced += seconds;
        phrase.lastVoice = clock + seconds;
        emit({
          type: 'transcript',
          text: '[mock] Spoken answer',
          isFinal: false,
          speechFinal: false,
          confidence: null,
          start: phrase.start,
          duration: phrase.lastVoice - phrase.start,
        });
      }
      clock += seconds;
      if (phrase && clock - phrase.lastVoice >= MOCK_PHRASE_PAUSE_SEC) endPhrase();
      if (
        !phrase &&
        !utteranceEnded &&
        lastWordEnd !== null &&
        clock - lastWordEnd >= request.utteranceEndMs / 1000
      ) {
        utteranceEnded = true;
        emit({ type: 'utterance_end', lastWordEnd });
      }
    },
    finalize() {
      endPhrase(true);
    },
    bufferedAmount: () => 0,
    async close() {
      if (!closed) {
        emit({ type: 'closed' });
        closed = true;
      }
      return { durationSec: Math.round(clock * 100) / 100, servedModel: 'mock-stt' };
    },
  };
}
