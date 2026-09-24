/**
 * Browser media helpers for voice and video interviews: format choice,
 * microphone and camera access, a live input level and a test tone.
 * Everything here releases what it opens (tracks, AudioContexts) through the
 * returned `close`/`stop`.
 */

/** MediaRecorder formats the speech service accepts, in order of preference. */
export const RECORDER_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

/** MediaRecorder formats for video recordings, in order of preference (Safari records MP4). */
export const VIDEO_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
] as const;

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export interface VoiceSupport {
  getUserMedia: boolean;
  mediaRecorder: boolean;
  audioContext: boolean;
  /** The first supported recording format, or null when none is. */
  mimeType: string | null;
}

/** What this browser offers for recording answers. */
export function detectVoiceSupport(): VoiceSupport {
  const getUserMedia =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const mediaRecorder = typeof globalThis.MediaRecorder === 'function';
  return {
    getUserMedia,
    mediaRecorder,
    audioContext: audioContextCtor() !== null,
    mimeType: mediaRecorder ? pickMimeType() : null,
  };
}

/** The first accepted format the browser can record, or null. */
export function pickMimeType(): string | null {
  const recorder = globalThis.MediaRecorder;
  if (typeof recorder?.isTypeSupported !== 'function') return null;
  return RECORDER_MIME_TYPES.find((type) => recorder.isTypeSupported(type)) ?? null;
}

/** The first video recording format the browser supports, or null. */
export function pickVideoMimeType(): string | null {
  const recorder = globalThis.MediaRecorder;
  if (typeof recorder?.isTypeSupported !== 'function') return null;
  return VIDEO_MIME_TYPES.find((type) => recorder.isTypeSupported(type)) ?? null;
}

/** The container a recorder produces, without codecs: the Content-Type of uploaded segments. */
export function containerType(mimeType: string): 'video/webm' | 'video/mp4' {
  return mimeType.split(';')[0]!.trim().toLowerCase() === 'video/mp4' ? 'video/mp4' : 'video/webm';
}

/** Browser name and major version for support (no other detail). */
export function browserLabel(ua: string = navigator.userAgent): string | null {
  const patterns: [string, RegExp][] = [
    ['Edge', /Edg\/(\d+)/],
    ['Opera', /OPR\/(\d+)/],
    ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Firefox', /Firefox\/(\d+)/],
    ['Chrome', /Chrome\/(\d+)/],
    ['Safari', /Version\/(\d+)[\d.]*.*Safari\//],
  ];
  for (const [name, re] of patterns) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return null;
}

export type MicProblem = 'denied' | 'noDevice' | 'inUse' | 'unsupported' | 'other';

/** Why the microphone could not be opened, from a getUserMedia error. */
export function micProblem(err: unknown): MicProblem {
  const name = (err as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return 'noDevice';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'inUse';
    case 'TypeError':
      return 'unsupported';
    default:
      return 'other';
  }
}

/** Asks for the microphone with the processing that suits speech. */
export function openMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

/** Asks for the camera and microphone together (video interviews). */
export function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

export interface LevelMeter {
  /** Input level from 0 (silence) to 1 (very loud). */
  read(): number;
  close(): void;
}

/** A live input level for a stream (AudioContext + AnalyserNode); null without Web Audio. */
export function createLevelMeter(stream: MediaStream): LevelMeter | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buffer = new Uint8Array(analyser.fftSize);
  let closed = false;
  return {
    read() {
      if (closed) return 0;
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const value of buffer) {
        const centred = (value - 128) / 128;
        sum += centred * centred;
      }
      // RMS of speech rarely passes 0.3; scale so normal speech fills most of the meter.
      return Math.min(1, Math.sqrt(sum / buffer.length) * 3);
    },
    close() {
      if (closed) return;
      closed = true;
      source.disconnect();
      void ctx.close().catch(() => undefined);
    },
  };
}

/**
 * Plays a short, gentle test tone through the speakers (OscillatorNode).
 * Resolves when it has finished; `stop` ends it early and releases the context.
 */
export function playTestTone(durationSec = 1.2): { done: Promise<void>; stop: () => void } {
  const Ctor = audioContextCtor();
  if (!Ctor) return { done: Promise.reject(new Error('Web Audio unavailable')), stop: () => {} };
  const ctx = new Ctor();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 523.25; // C5: easy to hear on laptop speakers.
  const t0 = ctx.currentTime;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.25, t0 + 0.05);
  gain.gain.setValueAtTime(0.25, t0 + durationSec - 0.15);
  gain.gain.linearRampToValueAtTime(0, t0 + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      osc.stop();
    } catch {
      // Already stopped.
    }
    void ctx.close().catch(() => undefined);
  };
  const done = new Promise<void>((resolve) => {
    osc.onended = () => {
      close();
      resolve();
    };
  });
  void ctx.resume?.().catch(() => undefined);
  osc.start(t0);
  osc.stop(t0 + durationSec);
  return { done, stop: close };
}

/** mm:ss for recording times. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
