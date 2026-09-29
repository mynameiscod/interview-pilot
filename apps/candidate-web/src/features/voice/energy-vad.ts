import { REALTIME_VOICE } from '@cbi/shared-types';

export interface EnergyVadOptions {
  /** Speech must last this long to count (a cough or a click does not). */
  startMs?: number;
  /** Quiet this long ends speech. */
  stopMs?: number;
  /** Speech is this many times louder than the room's noise floor… */
  ratio?: number;
  /** …and at least this loud (RMS of float samples). */
  minLevel?: number;
}

/**
 * A small energy-based voice activity detector for barge-in: it follows the
 * room's noise floor (an average of quiet frames, and very slowly of loud
 * ones, so a steady fan stops counting) and reports speech
 * once frames stay clearly above it for `startMs`. It needs no model and no
 * extra download; the speech service's own detection covers the rest.
 */
export function createEnergyVad(opts: EnergyVadOptions = {}) {
  const startMs = opts.startMs ?? REALTIME_VOICE.bargeInMs;
  const stopMs = opts.stopMs ?? 600;
  const ratio = opts.ratio ?? 3;
  const minLevel = opts.minLevel ?? 0.02;
  let floor = 0.005;
  let loudMs = 0;
  let quietMs = 0;
  let speaking = false;

  return {
    get speaking() {
      return speaking;
    },
    /** Feeds one frame's level; returns `start` or `stop` when the state changes. */
    process(level: number, frameMs: number = REALTIME_VOICE.frameMs): 'start' | 'stop' | null {
      const loud = level >= minLevel && level >= floor * ratio;
      if (!loud) {
        // Only quiet frames teach the noise floor, so speech never raises it.
        floor = floor * 0.95 + Math.max(level, 0.001) * 0.05;
        loudMs = 0;
        if (speaking) {
          quietMs += frameMs;
          if (quietMs >= stopMs) {
            speaking = false;
            return 'stop';
          }
        }
        return null;
      }
      // A sustained sound (a fan, traffic) slowly becomes the floor too.
      floor = floor * 0.995 + level * 0.005;
      quietMs = 0;
      loudMs += frameMs;
      if (!speaking && loudMs >= startMs) {
        speaking = true;
        return 'start';
      }
      return null;
    },
    reset() {
      loudMs = 0;
      quietMs = 0;
      speaking = false;
    },
  };
}

export type EnergyVad = ReturnType<typeof createEnergyVad>;
