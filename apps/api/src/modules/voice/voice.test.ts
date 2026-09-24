import { describe, expect, it } from 'vitest';
import { sniffAudio } from './voice.service.js';

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
