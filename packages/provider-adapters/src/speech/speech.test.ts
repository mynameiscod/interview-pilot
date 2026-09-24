import { AiProviderError, type ModelTarget } from '@cbi/ai-core';
import { describe, expect, it, vi } from 'vitest';
import { createDeepgramSttAdapter } from './deepgram.js';
import { createElevenLabsTtsAdapter, ELEVENLABS_DEFAULT_VOICE } from './elevenlabs.js';
import { createMockSttAdapter, createMockTtsAdapter, mockSpeech, mockSpeechWav } from './mock.js';
import { createOpenAiSttAdapter, createOpenAiTtsAdapter } from './openai.js';

const target = (modelId: string, voice?: string | null): ModelTarget => ({
  providerKey: 'openai',
  modelId,
  params: {
    temperature: null,
    maxOutputTokens: 16,
    timeoutMs: 5000,
    retries: 0,
    concurrency: 5,
    voice,
  },
});
const credentials = { apiKey: 'secret-key' };
const signal = new AbortController().signal;
const stt = (language: string | null = 'en') => ({
  audio: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/webm;codecs=opus',
  language,
  durationSec: 7,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Deepgram STT', () => {
  it('posts raw audio with the model and language and reads the best alternative', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(200, {
        metadata: { duration: 6.5 },
        results: {
          channels: [
            { alternatives: [{ transcript: ' I led the migration. ', confidence: 0.93 }] },
          ],
        },
      }),
    );
    const out = await createDeepgramSttAdapter({ fetchImpl }).transcribe({
      model: target('nova-3'),
      request: stt('hi'),
      credentials,
      signal,
    });
    expect(out).toEqual({
      text: 'I led the migration.',
      language: 'hi',
      confidence: 0.93,
      durationSec: 6.5,
      servedModel: null,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&language=hi',
    );
    expect(init.headers).toMatchObject({
      Authorization: 'Token secret-key',
      'Content-Type': 'audio/webm',
    });
  });

  it('asks for language detection without a hint and maps HTTP errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, { results: { channels: [{ detected_language: 'te', alternatives: [{}] }] } }),
      )
      .mockResolvedValueOnce(json(400, { err_msg: 'Unsupported language: echoes input' }))
      .mockResolvedValueOnce(json(429, {}));
    const adapter = createDeepgramSttAdapter({ fetchImpl });
    const out = await adapter.transcribe({
      model: target('nova-3'),
      request: stt(null),
      credentials,
      signal,
    });
    expect(out).toMatchObject({ text: '', language: 'te', durationSec: null });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('detect_language=true');
    const bad = await adapter
      .transcribe({ model: target('nova-3'), request: stt(), credentials, signal })
      .catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(AiProviderError);
    expect(bad).toMatchObject({ outcome: 'BAD_REQUEST', retryable: false });
    expect(String((bad as Error).message)).not.toContain('echoes input');
    await expect(
      adapter.transcribe({ model: target('nova-3'), request: stt(), credentials, signal }),
    ).rejects.toMatchObject({ outcome: 'RATE_LIMITED', retryable: true });
  });

  it('reports network failures as retryable', async () => {
    const adapter = createDeepgramSttAdapter({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    });
    await expect(
      adapter.transcribe({ model: target('nova-3'), request: stt(), credentials, signal }),
    ).rejects.toMatchObject({ outcome: 'NETWORK_ERROR', retryable: true });
  });
});

describe('OpenAI speech', () => {
  it('uploads a named file for transcription and reads billed seconds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        json(200, { text: 'Hello there', usage: { type: 'duration', seconds: 7 } }),
      );
    const out = await createOpenAiSttAdapter({ fetchImpl }).transcribe({
      model: target('gpt-4o-mini-transcribe'),
      request: stt('te'),
      credentials,
      signal,
    });
    expect(out).toMatchObject({ text: 'Hello there', durationSec: 7, language: 'te' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('language')).toBe('te');
    expect((form.get('file') as File).name).toBe('answer.webm');
  });

  it('synthesizes MP3 with the configured voice and interviewer style', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([9, 9, 9]), { status: 200 }));
    const out = await createOpenAiTtsAdapter({ fetchImpl }).synthesize({
      model: target('gpt-4o-mini-tts', 'verse'),
      request: { text: 'Tell me about yourself.', language: 'en' },
      credentials,
      signal,
    });
    expect(out).toEqual({
      audio: new Uint8Array([9, 9, 9]),
      mimeType: 'audio/mpeg',
      servedModel: null,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'verse',
      response_format: 'mp3',
    });
    expect(body.instructions).toContain('interviewer');
  });

  it('treats an empty audio body as a provider error', async () => {
    const adapter = createOpenAiTtsAdapter({
      fetchImpl: vi.fn().mockResolvedValue(new Response(new Uint8Array(), { status: 200 })),
    });
    await expect(
      adapter.synthesize({
        model: target('tts-1'),
        request: { text: 'x', language: null },
        credentials,
        signal,
      }),
    ).rejects.toMatchObject({ outcome: 'PROVIDER_ERROR', code: 'empty_audio' });
  });
});

describe('ElevenLabs TTS', () => {
  it('uses the default voice and sends the language to v2.5 models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    await createElevenLabsTtsAdapter({ fetchImpl }).synthesize({
      model: target('eleven_flash_v2_5'),
      request: { text: 'Namaste', language: 'hi' },
      credentials,
      signal,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE}?output_format=mp3_44100_64`,
    );
    expect(init.headers['xi-api-key']).toBe('secret-key');
    expect(JSON.parse(init.body)).toEqual({
      text: 'Namaste',
      model_id: 'eleven_flash_v2_5',
      language_code: 'hi',
    });
  });

  it('maps an invalid key to AUTH_ERROR', async () => {
    const adapter = createElevenLabsTtsAdapter({
      fetchImpl: vi.fn().mockResolvedValue(json(401, { detail: 'invalid' })),
    });
    await expect(
      adapter.synthesize({
        model: target('eleven_multilingual_v2'),
        request: { text: 'x', language: null },
        credentials,
        signal,
      }),
    ).rejects.toMatchObject({ outcome: 'AUTH_ERROR' });
  });
});

describe('speech mocks', () => {
  it('transcribes scripted speech, flags unclear answers and simulates outages', async () => {
    const adapter = createMockSttAdapter();
    const run = (audio: Uint8Array) =>
      adapter.transcribe({
        model: target('mock-stt'),
        request: { audio, mimeType: 'audio/webm', language: null, durationSec: 12.4 },
        credentials,
        signal,
      });
    expect((await run(mockSpeech('I designed the cache layer.'))).text).toBe(
      'I designed the cache layer.',
    );
    expect((await run(mockSpeech('mumble [unclear]'))).confidence).toBeLessThan(0.5);
    expect((await run(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).text).toBe(
      '[mock] Spoken answer of about 12 seconds.',
    );
    await expect(run(new TextEncoder().encode('MOCK-SPEECH-FAIL'))).rejects.toMatchObject({
      outcome: 'PROVIDER_ERROR',
    });
  });

  it('produces a valid WAV whose length follows the text', async () => {
    const out = await createMockTtsAdapter().synthesize({
      model: target('mock-tts'),
      request: { text: 'x'.repeat(100), language: null },
      credentials,
      signal,
    });
    expect(out.mimeType).toBe('audio/wav');
    const head = new TextDecoder().decode(out.audio.subarray(0, 12));
    expect(head.startsWith('RIFF') && head.endsWith('WAVE')).toBe(true);
    // 100 chars ≈ 5 s of 16 kHz 16-bit mono.
    expect(out.audio.length).toBe(44 + 5 * 16_000 * 2);
    expect(mockSpeechWav('x'.repeat(10_000)).length).toBe(44 + 8 * 16_000 * 2);
  });
});
