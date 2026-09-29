import type { QuestionAudioEvent } from '@cbi/shared-types';

/**
 * Plays a question's audio while it is still arriving, sentence by
 * sentence. MP3 chunks go straight into a MediaSource (playback starts with
 * the first chunk); other formats, or browsers without MediaSource for MP3,
 * decode each complete sentence with Web Audio and queue it. `stop` silences
 * everything at once (barge-in).
 */
export interface StreamPlayer {
  push(event: QuestionAudioEvent): void;
  /** No more audio will come: `onEnded` fires when what was queued has played. */
  end(): void;
  stop(): void;
}

export interface StreamPlayerEvents {
  /** Sound started (the first chunk is audible). */
  onStart(): void;
  /** Everything queued has played after `end()`. */
  onEnded(): void;
  /** The browser refused to play without a click (autoplay policy). */
  onBlocked(): void;
}

/** Where the audio goes; the MediaSource and Web Audio versions below, or a test fake. */
export interface AudioOutput {
  append(chunk: Uint8Array, sentence: number, last: boolean): void;
  finish(): void;
  stop(): void;
}

type AudioContextCtor = typeof AudioContext;
const audioContextCtor = (): AudioContextCtor | null => {
  const w = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
};

export const canStreamMp3 = () =>
  typeof globalThis.MediaSource === 'function' && MediaSource.isTypeSupported('audio/mpeg');

/** What realtime voice needs: microphone capture with an AudioWorklet, and Web Audio playback. */
export function realtimeVoiceSupported(): boolean {
  const Ctor = audioContextCtor();
  return (
    Ctor !== null &&
    typeof globalThis.AudioWorkletNode === 'function' &&
    'audioWorklet' in Ctor.prototype &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/** MP3 through MediaSource: chunks are appended in order, as they arrive. */
function mediaSourceOutput(events: StreamPlayerEvents): AudioOutput {
  const source = new MediaSource();
  const audio = new Audio();
  const url = URL.createObjectURL(source);
  audio.src = url;
  const queue: Uint8Array[] = [];
  let buffer: SourceBuffer | null = null;
  let finished = false;
  let stopped = false;
  let started = false;
  const pump = () => {
    if (!buffer || buffer.updating || stopped) return;
    const next = queue.shift();
    if (next) {
      buffer.appendBuffer(next as Uint8Array<ArrayBuffer>);
      if (!started) {
        started = true;
        audio.play().then(events.onStart, events.onBlocked);
      }
    } else if (finished && source.readyState === 'open') {
      source.endOfStream();
    }
  };
  source.addEventListener('sourceopen', () => {
    buffer = source.addSourceBuffer('audio/mpeg');
    buffer.mode = 'sequence';
    buffer.addEventListener('updateend', pump);
    pump();
  });
  audio.onended = () => {
    if (!stopped) events.onEnded();
    URL.revokeObjectURL(url);
  };
  return {
    append(chunk) {
      queue.push(chunk);
      pump();
    },
    finish() {
      finished = true;
      pump();
    },
    stop() {
      stopped = true;
      audio.onended = null;
      audio.pause();
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
    },
  };
}

/** Anything else (the mock's WAV): each complete sentence is decoded and scheduled after the last. */
function webAudioOutput(events: StreamPlayerEvents): AudioOutput {
  const Ctor = audioContextCtor();
  const ctx = Ctor ? new Ctor() : null;
  const pieces = new Map<number, Uint8Array[]>();
  const sources = new Set<AudioBufferSourceNode>();
  let decoding: Promise<void> = Promise.resolve();
  let playAt = 0;
  let started = false;
  let finished = false;
  let stopped = false;
  let playing = 0;
  const maybeEnded = () => {
    if (finished && playing === 0 && !stopped) {
      events.onEnded();
      void ctx?.close().catch(() => undefined);
    }
  };
  return {
    append(chunk, sentence, last) {
      const parts = pieces.get(sentence) ?? [];
      parts.push(chunk);
      pieces.set(sentence, parts);
      if (!last || !ctx) return;
      pieces.delete(sentence);
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.byteLength;
      }
      playing += 1;
      decoding = decoding.then(async () => {
        if (stopped) return;
        try {
          const buffer = await ctx.decodeAudioData(bytes.buffer);
          if (stopped) return;
          if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
          if (ctx.state === 'suspended') {
            events.onBlocked();
            return;
          }
          const node = ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(ctx.destination);
          playAt = Math.max(playAt, ctx.currentTime);
          node.start(playAt);
          playAt += buffer.duration;
          sources.add(node);
          if (!started) {
            started = true;
            events.onStart();
          }
          await new Promise<void>((resolve) => (node.onended = () => resolve()));
          sources.delete(node);
        } catch {
          // An undecodable sentence is skipped; the text is on screen.
        } finally {
          playing -= 1;
          maybeEnded();
        }
      });
    },
    finish() {
      finished = true;
      if (playing === 0) maybeEnded();
    },
    stop() {
      stopped = true;
      for (const node of sources) {
        node.onended = null;
        try {
          node.stop();
        } catch {
          // Not started yet.
        }
      }
      sources.clear();
      void ctx?.close().catch(() => undefined);
    },
  };
}

/**
 * A player for one question. The output is chosen from the first chunk's
 * type; chunks for older sentences are ignored after `stop`.
 */
export function createStreamPlayer(
  events: StreamPlayerEvents,
  outputFor: (mimeType: string, events: StreamPlayerEvents) => AudioOutput = (mimeType, e) =>
    mimeType === 'audio/mpeg' && canStreamMp3() ? mediaSourceOutput(e) : webAudioOutput(e),
): StreamPlayer {
  let output: AudioOutput | null = null;
  let stopped = false;
  let ended = false;
  let startedOnce = false;
  let endedOnce = false;
  const guarded: StreamPlayerEvents = {
    onStart: () => {
      if (!startedOnce && !stopped) {
        startedOnce = true;
        events.onStart();
      }
    },
    onEnded: () => {
      if (!endedOnce && !stopped) {
        endedOnce = true;
        events.onEnded();
      }
    },
    onBlocked: () => {
      if (!stopped) events.onBlocked();
    },
  };
  return {
    push(event) {
      if (stopped || ended) return;
      output ??= outputFor(event.mimeType, guarded);
      const audio =
        event.audio instanceof Uint8Array
          ? event.audio
          : new Uint8Array(event.audio as ArrayBuffer);
      output.append(audio, event.sentence, event.last);
    },
    end() {
      if (stopped || ended) return;
      ended = true;
      if (output) output.finish();
      else guarded.onEnded();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      output?.stop();
    },
  };
}
