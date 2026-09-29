import { describe, expect, it } from 'vitest';
import {
  DELIVERY_TARGETS,
  DeliveryMetrics,
  deliveryMetrics,
  deliveryTips,
  deliveryTokens,
  summarizeDelivery,
} from './delivery.js';

/** Evenly spaced words: `count` words, each 0.3 s long, `gap` seconds apart. */
const timed = (count: number, gap = 0.1, pauses: Record<number, number> = {}) => {
  const words = [];
  let t = 0.5;
  for (let i = 0; i < count; i++) {
    t += pauses[i] ?? 0;
    words.push({ start: t, end: t + 0.3 });
    t += 0.3 + gap;
  }
  return words;
};

describe('deliveryTokens', () => {
  it('splits words and records the punctuation around them', () => {
    const tokens = deliveryTokens("So, I'd say it's fine. Like, really");
    expect(tokens.map((t) => t.word)).toEqual(['so', 'id', 'say', 'its', 'fine', 'like', 'really']);
    expect(tokens[0]).toMatchObject({ sentenceStart: true, breakAfter: true });
    expect(tokens[5]).toMatchObject({ sentenceStart: true, breakBefore: true, breakAfter: true });
    expect(tokens[2]).toMatchObject({ breakBefore: false, breakAfter: false });
  });
});

describe('deliveryMetrics', () => {
  it('counts English fillers, but not "like" or "so" used as ordinary words', () => {
    const m = deliveryMetrics({
      text: 'So um I basically, you know, like, rebuilt it. I like Go and it was so fast. Do you know Rust?',
      durationSec: 10,
    });
    // um, so (leading), basically, you know, like (delimited). Not: "I like Go", "so fast", "do you know".
    expect(m.fillerCount).toBe(5);
    expect(m.topFillers.map((f) => f.text).sort()).toEqual(['basically', 'like', 'so']);
    expect(m.wordCount).toBe(21);
    expect(m.fillerRate).toBeCloseTo((5 * 100) / 21, 1);
  });

  it('counts Hindi and Telugu fillers for answers in those languages', () => {
    const hi = deliveryMetrics({
      text: 'मतलब मैंने, वो, सिस्टम बनाया। वो सिस्टम तेज़ था',
      durationSec: 5,
      language: 'hi',
    });
    expect(hi.fillerCount).toBe(2); // मतलब, delimited वो; the pronoun वो is not counted
    const te = deliveryMetrics({
      text: 'అంటే నేను, ఆ, కోడ్ రాశాను. ఆ సమయంలో అది పని చేసింది',
      durationSec: 5,
      language: 'te',
    });
    expect(te.fillerCount).toBe(2); // అంటే and the delimited ఆ
    // Hindi lists do not apply to English answers.
    expect(deliveryMetrics({ text: 'matlab it works', durationSec: 5 }).fillerCount).toBe(0);
  });

  it('counts hedging phrases', () => {
    const m = deliveryMetrics({
      text: "I think it worked. Maybe it was the cache, I'm not sure, kind of.",
      durationSec: 6,
    });
    expect(m.hedgeCount).toBe(4);
  });

  it('measures pace and long pauses from word timestamps', () => {
    const words = timed(60, 0.1, { 20: 2.5, 40: 3 });
    const m = deliveryMetrics({
      text: Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '),
      durationSec: 40,
      words,
    });
    const span = words.at(-1)!.end - words[0]!.start;
    expect(m.timestamps).toBe(true);
    expect(m.wpm).toBe(Math.round(60 / (span / 60)));
    expect(m.longPauses).toBe(2);
    expect(m.longestPauseSec).toBeCloseTo(3.1, 1);
    expect(DeliveryMetrics.parse(m)).toEqual(m);
  });

  it('falls back to the recording length without timestamps', () => {
    const m = deliveryMetrics({ text: 'one two three four five six', durationSec: 3 });
    expect(m).toMatchObject({
      wpm: 120,
      longPauses: null,
      longestPauseSec: null,
      timestamps: false,
    });
    // Too short to measure a pace.
    expect(deliveryMetrics({ text: 'yes', durationSec: 1 }).wpm).toBeNull();
  });
});

describe('summarizeDelivery and deliveryTips', () => {
  const answer = (over: Partial<DeliveryMetrics>): DeliveryMetrics => ({
    durationSec: 60,
    wordCount: 140,
    wpm: 140,
    fillerCount: 1,
    fillerRate: 0.7,
    topFillers: [{ text: 'um', count: 1 }],
    longPauses: 0,
    longestPauseSec: 1,
    hedgeCount: 0,
    topHedges: [],
    timestamps: true,
    ...over,
  });

  it('weights pace by words and time, and adds counts', () => {
    const s = summarizeDelivery([
      answer({ wordCount: 100, wpm: 100 }),
      answer({ wordCount: 200, wpm: 200, longPauses: null }),
    ]);
    expect(s).toMatchObject({ answers: 2, wordCount: 300, fillerCount: 2, longPauses: 0 });
    expect(s.wpm).toBe(150); // 300 words over 2 minutes
    expect(s.topFillers).toEqual([{ text: 'um', count: 2 }]);
  });

  it('gives no tips when delivery is on target', () => {
    expect(deliveryTips(summarizeDelivery([answer({})]))).toEqual([]);
  });

  it('flags pace, fillers, pauses and hedging against the targets', () => {
    const s = summarizeDelivery([
      answer({
        wpm: DELIVERY_TARGETS.wpm.max + 30,
        fillerCount: 10,
        longPauses: 3,
        hedgeCount: 5,
      }),
    ]);
    expect(deliveryTips(s)).toEqual(['PACE_FAST', 'FILLERS', 'PAUSES', 'HEDGING']);
    expect(deliveryTips(summarizeDelivery([answer({ wpm: 90 })]))).toEqual(['PACE_SLOW']);
  });
});
