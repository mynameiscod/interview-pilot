import { describe, expect, it } from 'vitest';
import { consentRequirements } from './consent.js';
import { INTEGRITY_NOTE, summarizeIntegrity } from './media.js';
import { deviceCheckPassed } from './voice.js';

describe('summarizeIntegrity', () => {
  const start = '2026-09-24T10:00:00.000Z';
  const at = (sec: number) => new Date(Date.parse(start) + sec * 1000).toISOString();

  it('counts events, estimates time away without double counting and keeps a neutral note', () => {
    const summary = summarizeIntegrity(
      [
        { type: 'TAB_HIDDEN', at: at(60), value: null },
        { type: 'WINDOW_BLUR', at: at(60), value: null },
        { type: 'TAB_VISIBLE', at: at(90), value: 30_000 },
        { type: 'WINDOW_FOCUS', at: at(90), value: 29_000 },
        { type: 'PASTE', at: at(300), value: 140 },
      ],
      start,
    );
    expect(summary.counts).toEqual({
      TAB_HIDDEN: 1,
      WINDOW_BLUR: 1,
      TAB_VISIBLE: 1,
      WINDOW_FOCUS: 1,
      PASTE: 1,
    });
    expect(summary.awaySec).toBe(30);
    expect(summary.timeline).toEqual([
      { type: 'TAB_HIDDEN', offsetSec: 60 },
      { type: 'WINDOW_BLUR', offsetSec: 60 },
      { type: 'PASTE', offsetSec: 300 },
    ]);
    expect(summary.note).toBe(INTEGRITY_NOTE);
    expect(summarizeIntegrity([], null)).toMatchObject({ counts: {}, awaySec: 0, timeline: [] });
  });
});

describe('consent requirements', () => {
  const policy = (recording: 'OFF' | 'OPTIONAL' | 'REQUIRED', tabSwitchTracking = false) => ({
    recording,
    tabSwitchTracking,
  });

  it('asks only what each mode and policy needs', () => {
    expect(consentRequirements('TEXT', policy('REQUIRED'))).toEqual([]);
    expect(consentRequirements('VOICE', policy('REQUIRED'))).toEqual([
      { type: 'VOICE_PROCESSING', required: true },
    ]);
    expect(consentRequirements('VIDEO', policy('OPTIONAL'))).toEqual([
      { type: 'VOICE_PROCESSING', required: true },
      { type: 'RECORDING', required: false },
    ]);
    expect(consentRequirements('VIDEO', policy('OFF', true))).toEqual([
      { type: 'VOICE_PROCESSING', required: true },
      { type: 'INTEGRITY', required: true },
    ]);
    expect(consentRequirements('TEXT', policy('OFF', true))).toEqual([
      { type: 'INTEGRITY', required: true },
    ]);
  });

  it('requires a working camera only for video', () => {
    const base = { microphone: 'PASS', recorder: 'PASS' } as const;
    expect(deviceCheckPassed({ ...base, camera: null }, 'VOICE')).toBe(true);
    expect(deviceCheckPassed({ ...base, camera: null }, 'VIDEO')).toBe(false);
    expect(deviceCheckPassed({ ...base, camera: 'WARN' }, 'VIDEO')).toBe(true);
    expect(deviceCheckPassed({ ...base, camera: 'FAIL' }, 'VIDEO')).toBe(false);
  });
});
