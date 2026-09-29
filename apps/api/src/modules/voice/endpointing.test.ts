import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEndpointDetector } from './endpointing.js';

const policy = { silenceMs: 700, minAnswerWords: 3, minSpeechMs: 1200, longSilenceMs: 6000 };

function setup() {
  const onTurnEnd = vi.fn();
  const onResume = vi.fn();
  const detector = createEndpointDetector({ onTurnEnd, onResume, policy });
  const final = (text: string, duration: number, speechFinal = true) =>
    detector.transcript({ text, isFinal: true, speechFinal, duration });
  const interim = (text: string) =>
    detector.transcript({ text, isFinal: false, speechFinal: false, duration: 0 });
  return { detector, onTurnEnd, onResume, final, interim };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('endpointing', () => {
  it('ends a long-enough answer after the utterance end and a quiet spell', () => {
    const t = setup();
    t.interim('I led the');
    t.final('I led the payments migration', 1.6, false);
    t.detector.utteranceEnd();
    expect(t.detector.state).toBe('pending');
    vi.advanceTimersByTime(699);
    expect(t.onTurnEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.onTurnEnd).toHaveBeenCalledOnce();
    expect(t.detector.state).toBe('ended');
  });

  it('treats a speech-final segment like an utterance end', () => {
    const t = setup();
    t.final('We moved to event sourcing', 1.5, true);
    vi.advanceTimersByTime(700);
    expect(t.onTurnEnd).toHaveBeenCalledOnce();
  });

  it('keeps listening while the candidate is still talking', () => {
    const t = setup();
    t.final('First we measured', 1.3, true);
    vi.advanceTimersByTime(500);
    t.interim('then we');
    vi.advanceTimersByTime(5000);
    expect(t.onTurnEnd).not.toHaveBeenCalled();
    t.final('then we sharded the database', 1.2, true);
    vi.advanceTimersByTime(700);
    expect(t.onTurnEnd).toHaveBeenCalledOnce();
    expect(t.detector.words).toBe(8);
  });

  it('does not end a very short answer on a normal pause, only after a long silence', () => {
    const t = setup();
    t.final('Yes', 0.3, true);
    t.detector.utteranceEnd();
    vi.advanceTimersByTime(5999);
    expect(t.onTurnEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.onTurnEnd).toHaveBeenCalledOnce();
  });

  it('never ends an answer with no words', () => {
    const t = setup();
    t.detector.utteranceEnd();
    t.final('', 0, true);
    vi.advanceTimersByTime(60_000);
    expect(t.onTurnEnd).not.toHaveBeenCalled();
  });

  it('ends even when the provider never sends an utterance end', () => {
    const t = setup();
    t.final('I would start with the logs', 1.5, false);
    vi.advanceTimersByTime(6000);
    expect(t.onTurnEnd).toHaveBeenCalledOnce();
  });

  it('a speech start postpones a pending end but does not reopen an ended turn', () => {
    const t = setup();
    t.final('I would start with the logs', 1.5, true);
    vi.advanceTimersByTime(600);
    t.detector.speechStarted();
    vi.advanceTimersByTime(700);
    expect(t.onTurnEnd).not.toHaveBeenCalled();
    // Only noise followed: the long-silence rule ends it.
    vi.advanceTimersByTime(5300);
    expect(t.onTurnEnd).toHaveBeenCalledOnce();
    t.detector.speechStarted();
    expect(t.onResume).not.toHaveBeenCalled();
    expect(t.detector.state).toBe('ended');
  });

  it('reopens the turn when words follow its end (the candidate kept talking)', () => {
    const t = setup();
    t.final('I would start with the logs', 1.5, true);
    vi.advanceTimersByTime(700);
    expect(t.onTurnEnd).toHaveBeenCalledOnce();
    t.interim('and then');
    expect(t.onResume).toHaveBeenCalledOnce();
    expect(t.detector.state).toBe('listening');
    t.final('and then the metrics', 1, true);
    vi.advanceTimersByTime(700);
    expect(t.onTurnEnd).toHaveBeenCalledTimes(2);
  });

  it('stops deciding once the candidate ended the turn or the stream closed', () => {
    const t = setup();
    t.final('I would start with the logs', 1.5, true);
    t.detector.ended();
    vi.advanceTimersByTime(10_000);
    expect(t.onTurnEnd).not.toHaveBeenCalled();
    const u = setup();
    u.final('I would start with the logs', 1.5, true);
    u.detector.dispose();
    vi.advanceTimersByTime(10_000);
    expect(u.onTurnEnd).not.toHaveBeenCalled();
  });
});
