import { describe, expect, it } from 'vitest';
import { createEnergyVad } from './energy-vad';
import { createDownsampler, createFramer, FRAME_SAMPLES, rms, toPcm16 } from './pcm';

const tone = (n: number, amplitude = 0.5, period = 48) =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / period) * amplitude);

describe('PCM helpers', () => {
  it('downsamples 48 kHz to 16 kHz across block boundaries', () => {
    const down = createDownsampler(48_000);
    // Render quantum sized blocks, as an AudioWorklet delivers them.
    let total = 0;
    for (let i = 0; i < 30; i++) total += down(new Float32Array(128).fill(0.25)).length;
    expect(total).toBe(1280);
    const out = down(new Float32Array(3).fill(0.25));
    expect([...out]).toEqual([0.25]);
  });

  it('handles rates that do not divide evenly (44.1 kHz)', () => {
    const down = createDownsampler(44_100);
    let total = 0;
    for (let i = 0; i < 100; i++) total += down(new Float32Array(441)).length;
    expect(total).toBeGreaterThanOrEqual(15_999);
    expect(total).toBeLessThanOrEqual(16_000);
  });

  it('writes clamped little-endian PCM16', () => {
    const bytes = toPcm16(Float32Array.from([0, 1, -1, 2]));
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2, 3].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });

  it('cuts 100 ms frames and reports their level', () => {
    const framer = createFramer();
    expect(framer(tone(FRAME_SAMPLES - 1))).toEqual([]);
    const frames = framer(tone(2));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.audio.byteLength).toBe(3200);
    expect(frames[0]!.level).toBeCloseTo(rms(tone(FRAME_SAMPLES)), 1);
    expect(framer(tone(FRAME_SAMPLES * 2))).toHaveLength(2);
  });
});

describe('energy VAD', () => {
  it('reports speech only after it lasts, and its end after a quiet spell', () => {
    const vad = createEnergyVad({ startMs: 250, stopMs: 600 });
    for (let i = 0; i < 20; i++) expect(vad.process(0.004)).toBeNull();
    // A 100 ms click is not speech.
    expect(vad.process(0.2)).toBeNull();
    expect(vad.process(0.004)).toBeNull();
    expect([vad.process(0.2), vad.process(0.2), vad.process(0.2)]).toEqual([null, null, 'start']);
    expect(vad.speaking).toBe(true);
    for (let i = 0; i < 5; i++) expect(vad.process(0.004)).toBeNull();
    expect(vad.process(0.004)).toBe('stop');
  });

  it('adapts to a noisy room', () => {
    const vad = createEnergyVad();
    // A steady fan at 0.03 becomes the floor instead of speech.
    for (let i = 0; i < 200; i++) vad.process(0.03 * (i < 5 ? 0.1 : 1));
    for (let i = 0; i < 5; i++) expect(vad.process(0.04)).toBeNull();
    const events = [0.2, 0.2, 0.2].map((l) => vad.process(l));
    expect(events).toContain('start');
  });
});
