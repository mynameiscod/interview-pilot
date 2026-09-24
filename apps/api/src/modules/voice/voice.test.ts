import { VOICE_CONSENT_VERSION } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { sniffAudio, voiceReadiness, voiceStartBlocker } from './voice.service.js';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

describe('sniffAudio', () => {
  it('recognises the containers browsers record and common audio files', () => {
    expect(sniffAudio(bytes([0x1a, 0x45, 0xdf, 0xa3], 'webm'))).toBe('audio/webm');
    expect(sniffAudio(bytes('OggS', [0, 2]))).toBe('audio/ogg');
    expect(sniffAudio(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe('audio/wav');
    expect(sniffAudio(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toBe('audio/mp4');
    expect(sniffAudio(bytes('ID3', [4, 0]))).toBe('audio/mpeg');
    expect(sniffAudio(bytes([0xff, 0xfb, 0x90]))).toBe('audio/mpeg');
  });

  it('rejects anything else, whatever it claims to be', () => {
    expect(sniffAudio(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffAudio(bytes('<html>'))).toBeNull();
    expect(sniffAudio(new Uint8Array())).toBeNull();
  });
});

describe('voice readiness', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const check = (passed: boolean, hoursAgo = 1) => ({
    microphone: passed ? ('PASS' as const) : ('FAIL' as const),
    recorder: 'PASS' as const,
    speaker: 'WARN' as const,
    network: 'PASS' as const,
    speechService: 'PASS' as const,
    mimeType: 'audio/webm',
    rttMs: 100,
    browser: null,
    at: new Date(now.getTime() - hoursAgo * 3600_000),
    passed,
  });
  const consent = { version: VOICE_CONSENT_VERSION, at: now };
  const session = (
    deviceCheck: ReturnType<typeof check> | null,
    c = consent as typeof consent | null,
  ) => ({
    voice: { deviceCheck, consent: c, modeHistory: [] },
  });

  it('is ready with a recent passing check and current consent', () => {
    expect(voiceReadiness(session(check(true)), now).ready).toBe(true);
    expect(voiceStartBlocker(session(check(true)), now)).toBeNull();
  });

  it('explains what is missing', () => {
    expect(voiceStartBlocker({ voice: null }, now)).toMatch(/device check/);
    expect(voiceStartBlocker(session(check(false)), now)).toMatch(/microphone/);
    expect(voiceStartBlocker(session(check(true, 25)), now)).toMatch(/expired/);
    expect(voiceStartBlocker(session(check(true), null), now)).toMatch(/notice/);
    expect(
      voiceReadiness(session(check(true), { version: 'voice-2020-01', at: now }), now).ready,
    ).toBe(false);
  });
});
