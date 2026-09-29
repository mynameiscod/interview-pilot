import { REALTIME_VOICE } from '@cbi/shared-types';

/**
 * Microphone audio for realtime voice: resampled to 16 kHz mono PCM16 and
 * cut into 100 ms frames, which is what the speech service streams. Pure
 * functions, so they are tested without an audio device.
 */

export const FRAME_SAMPLES = (REALTIME_VOICE.sampleRate * REALTIME_VOICE.frameMs) / 1000;

/**
 * A streaming downsampler (e.g. 48 kHz → 16 kHz). Each output sample is the
 * average of the input samples it covers, which also filters out most of
 * what would alias. The fractional position carries over between blocks, so
 * block boundaries do not click.
 */
export function createDownsampler(inputRate: number, outputRate = REALTIME_VOICE.sampleRate) {
  const ratio = inputRate / outputRate;
  let carry: number[] = [];
  let position = 0;
  return (block: Float32Array): Float32Array => {
    const input = carry.length ? Float32Array.from([...carry, ...block]) : block;
    const out: number[] = [];
    while (position + ratio <= input.length) {
      const start = Math.floor(position);
      const end = Math.min(input.length, Math.floor(position + ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += input[i]!;
      out.push(end > start ? sum / (end - start) : input[start]!);
      position += ratio;
    }
    const used = Math.floor(position);
    carry = Array.from(input.subarray(used));
    position -= used;
    return Float32Array.from(out);
  };
}

/** Float samples (-1…1) to little-endian PCM16 bytes. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return new Uint8Array(view.buffer);
}

/** Root-mean-square level of float samples (0 = silence). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** Collects resampled audio and hands out complete frames (PCM16 bytes plus their level). */
export function createFramer(frameSamples = FRAME_SAMPLES) {
  let pending: number[] = [];
  return (samples: Float32Array): { audio: Uint8Array; level: number }[] => {
    for (const s of samples) pending.push(s);
    const frames: { audio: Uint8Array; level: number }[] = [];
    while (pending.length >= frameSamples) {
      const frame = Float32Array.from(pending.slice(0, frameSamples));
      pending = pending.slice(frameSamples);
      frames.push({ audio: toPcm16(frame), level: rms(frame) });
    }
    return frames;
  };
}
