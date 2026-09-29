import { describe, expect, it } from 'vitest';
import { AnswerTextPayload, RtErrorCode } from './interview-runtime.js';
import { KNOWN_FLAGS } from './system.js';
import {
  REALTIME_VOICE,
  REALTIME_VOICE_FLAG,
  realtimeSttSupported,
  VoiceStreamAudioPayload,
  VoiceStreamStartPayload,
} from './voice-realtime.js';

describe('realtime voice contracts', () => {
  it('is a known flag', () => {
    expect(Object.keys(KNOWN_FLAGS)).toContain(REALTIME_VOICE_FLAG);
  });

  it('streams English and Hindi (code-switching); Telugu keeps push-to-talk', () => {
    expect(realtimeSttSupported('en')).toBe(true);
    expect(realtimeSttSupported('hi')).toBe(true);
    expect(realtimeSttSupported('te')).toBe(false);
  });

  it('accepts only 16 kHz PCM16 streams', () => {
    const base = { sessionId: 's1', questionId: 'q1', encoding: 'linear16', sampleRate: 16_000 };
    expect(VoiceStreamStartPayload.parse(base).resume).toBe(false);
    expect(VoiceStreamStartPayload.safeParse({ ...base, sampleRate: 48_000 }).success).toBe(false);
    expect(VoiceStreamStartPayload.safeParse({ ...base, encoding: 'opus' }).success).toBe(false);
  });

  it('audio frames must be binary', () => {
    const streamId = '0b8f6a4e-3b3c-4b8e-9a51-2f4a5c3c1d10';
    expect(
      VoiceStreamAudioPayload.safeParse({ streamId, seq: 0, audio: new Uint8Array(3200) }).success,
    ).toBe(true);
    expect(VoiceStreamAudioPayload.safeParse({ streamId, seq: 0, audio: 'AAAA' }).success).toBe(
      false,
    );
  });

  it('an edited spoken answer is flagged, and the room knows the new error codes', () => {
    const parsed = AnswerTextPayload.parse({
      sessionId: 's1',
      questionId: 'q1',
      text: 'Corrected text',
      clientMsgId: 'client-msg-1',
      voiceTranscriptId: '0b8f6a4e-3b3c-4b8e-9a51-2f4a5c3c1d10',
      voiceEdited: true,
    });
    expect(parsed.voiceEdited).toBe(true);
    expect(RtErrorCode.options).toEqual(
      expect.arrayContaining(['UNSUPPORTED', 'SPEECH_UNAVAILABLE']),
    );
    expect(REALTIME_VOICE.frameMs * REALTIME_VOICE.maxInFlightFrames).toBe(2_000);
  });
});
