import { REALTIME_VOICE } from '@cbi/shared-types';

export interface EndpointPolicy {
  /** Quiet after the provider's end of utterance before the answer counts as complete. */
  silenceMs: number;
  /** Shorter answers are not ended by a normal pause (the candidate may be thinking). */
  minAnswerWords: number;
  minSpeechMs: number;
  /** After this much quiet any answer with words is complete. */
  longSilenceMs: number;
}

export const DEFAULT_ENDPOINT_POLICY: EndpointPolicy = {
  silenceMs: REALTIME_VOICE.silenceMs,
  minAnswerWords: REALTIME_VOICE.minAnswerWords,
  minSpeechMs: REALTIME_VOICE.minSpeechMs,
  longSilenceMs: REALTIME_VOICE.longSilenceMs,
};

export type EndpointState = 'listening' | 'pending' | 'ended';

export interface EndpointTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: EndpointTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Decides when a streamed answer is complete (server-side endpointing).
 * Provider signals (a final segment with `speechFinal`, an utterance end)
 * only make the end *possible*: the answer must also be long enough, and
 * nothing may be heard for `silenceMs` afterwards. A short answer ends only
 * after `longSilenceMs` (or when the candidate taps send). Any new words
 * after the end reopen the turn (`onResume`), so a candidate who keeps
 * talking during the grace window simply continues their answer. A
 * `speech_started` alone (a cough, a door) postpones a pending end without
 * reopening one that already happened.
 */
export function createEndpointDetector(opts: {
  onTurnEnd: () => void;
  onResume: () => void;
  policy?: Partial<EndpointPolicy>;
  timers?: EndpointTimers;
}) {
  const policy = { ...DEFAULT_ENDPOINT_POLICY, ...opts.policy };
  const timers = opts.timers ?? realTimers;
  let state: EndpointState = 'listening';
  let words = 0;
  let speechMs = 0;
  let timer: unknown = null;
  let disposed = false;

  const disarm = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    if (state === 'pending') state = 'listening';
  };
  const arm = (ms: number) => {
    if (timer !== null) timers.clear(timer);
    state = 'pending';
    timer = timers.set(() => {
      timer = null;
      if (disposed || state !== 'pending') return;
      state = 'ended';
      opts.onTurnEnd();
    }, ms);
  };
  const longEnough = () => words >= policy.minAnswerWords && speechMs >= policy.minSpeechMs;
  /** The provider thinks the speaker paused: end after a quiet spell, if the answer allows it. */
  const maybeEnd = () => {
    if (state === 'ended' || words === 0) return;
    arm(longEnough() ? policy.silenceMs : policy.longSilenceMs);
  };
  /** Words were heard: the candidate is (still) answering. */
  const heard = () => {
    if (state === 'ended') {
      state = 'listening';
      opts.onResume();
    }
    disarm();
  };

  return {
    get state() {
      return state;
    },
    get words() {
      return words;
    },
    transcript(e: { text: string; isFinal: boolean; speechFinal: boolean; duration: number }) {
      if (disposed) return;
      const text = e.text.trim();
      if (!e.isFinal) {
        if (text) heard();
        return;
      }
      if (text) {
        heard();
        words += wordCount(text);
        speechMs += Math.max(0, e.duration) * 1000;
      }
      // A final segment is a pause of some length: never wait forever for the utterance end.
      if (e.speechFinal) maybeEnd();
      else if (text && state !== 'ended') arm(policy.longSilenceMs);
    },
    speechStarted() {
      if (disposed || state !== 'pending') return;
      disarm();
      // Nothing may follow (noise): the long silence rule still ends the answer.
      if (words > 0) arm(policy.longSilenceMs);
    },
    utteranceEnd() {
      if (!disposed) maybeEnd();
    },
    /** The turn was ended by the candidate (send now) or by the time limit. */
    ended() {
      disarm();
      state = 'ended';
    },
    dispose() {
      disposed = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
  };
}

export type EndpointDetector = ReturnType<typeof createEndpointDetector>;
