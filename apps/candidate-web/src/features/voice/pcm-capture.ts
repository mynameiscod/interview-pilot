import { createDownsampler, createFramer } from './pcm';

/**
 * The AudioWorklet processor (public/pcm-tap.worklet.js) copies each render
 * quantum to the main thread; resampling and framing happen here (pcm.ts),
 * which keeps the worklet trivial. It is a static file on the site because
 * the Content-Security-Policy's script-src, which covers worklets, allows
 * 'self' only.
 */
const WORKLET_URL = `${import.meta.env.BASE_URL}pcm-tap.worklet.js`;

export interface PcmCapture {
  close(): void;
}

/** A 100 ms frame of 16 kHz PCM16 and its level (RMS, 0–1). */
export type FrameListener = (audio: Uint8Array, level: number) => void;

/** Opens capture on a microphone stream (see `useRealtimeVoice`); tests pass a fake instead. */
export type CaptureFactory = (stream: MediaStream, onFrame: FrameListener) => Promise<PcmCapture>;

export const openPcmCapture: CaptureFactory = async (stream, onFrame) => {
  const w = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio unavailable');
  const ctx = new Ctor();
  try {
    await ctx.audioWorklet.addModule(WORKLET_URL);
  } catch (err) {
    void ctx.close().catch(() => undefined);
    throw err;
  }
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'cbi-pcm-tap', { numberOfOutputs: 0 });
  const downsample = createDownsampler(ctx.sampleRate);
  const frame = createFramer();
  let closed = false;
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (closed) return;
    for (const f of frame(downsample(e.data))) onFrame(f.audio, f.level);
  };
  source.connect(tap);
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  return {
    close() {
      if (closed) return;
      closed = true;
      tap.port.onmessage = null;
      source.disconnect();
      tap.disconnect();
      void ctx.close().catch(() => undefined);
    },
  };
};
