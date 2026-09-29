import { describe, expect, it } from 'vitest';
import { matchWords, quoteFound, UNVERIFIED_QUOTE_NOTE, verifyQuotes } from './quotes.js';

const ANSWER =
  'Checkout latency jumped from 200 ms to 4 s one evening. I checked the dashboards first: CPU was normal, but database connection wait time spiked. My hypothesis was pool exhaustion, so I looked at traces.';

describe('quoteFound', () => {
  it('accepts exact quotes regardless of case, punctuation and spacing', () => {
    expect(quoteFound('CPU was normal but database connection wait time spiked', ANSWER)).toBe(
      true,
    );
    expect(quoteFound('"my  hypothesis was POOL exhaustion."', ANSWER)).toBe(true);
    expect(quoteFound('latency jumped from 200 ms to 4 s', ANSWER)).toBe(true);
  });

  it('tolerates a small slip in a longer quote', () => {
    // One word changed out of eleven (transcription slip).
    expect(
      quoteFound(
        'I checked the dashboard first CPU was normal but database connection wait',
        ANSWER,
      ),
    ).toBe(true);
    // One filler word dropped.
    expect(quoteFound('so I looked at the traces', 'so I looked at the uh traces')).toBe(true);
  });

  it('matches elided quotes fragment by fragment, in order', () => {
    expect(quoteFound('Checkout latency jumped … I looked at traces', ANSWER)).toBe(true);
    expect(quoteFound('I looked at traces ... Checkout latency jumped', ANSWER)).toBe(false);
  });

  it('rejects paraphrases, invented quotes and short near-misses', () => {
    expect(quoteFound('we reduced duplicate charges by 99.7% in the first quarter', ANSWER)).toBe(
      false,
    );
    expect(quoteFound('the database pool was exhausted by a slow query', ANSWER)).toBe(false);
    expect(quoteFound('CPU spiked', ANSWER)).toBe(false);
    expect(quoteFound('', ANSWER)).toBe(false);
    expect(quoteFound('anything', '')).toBe(false);
  });

  it('works for Hindi and Telugu answers', () => {
    expect(matchWords('मैंने लॉग देखे, फिर!')).toEqual(['मैंने', 'लॉग', 'देखे', 'फिर']);
    expect(quoteFound('मैंने लॉग देखे', 'पहले मैंने लॉग देखे, फिर ट्रेस।')).toBe(true);
    expect(quoteFound('నేను లాగ్‌లు చూశాను', 'ముందు నేను లాగ్‌లు చూశాను.')).toBe(true);
    expect(quoteFound('मैंने कोड बदला', 'पहले मैंने लॉग देखे')).toBe(false);
  });
});

describe('verifyQuotes', () => {
  const item = (quote: string | null, confidence = 0.9, uncertainty: string | null = null) => ({
    questionId: 'q1',
    claim: 'c',
    confidence,
    quote,
    uncertainty,
  });

  it('keeps verified quotes, drops unverifiable ones and lowers their confidence', () => {
    const answers = new Map([['q1', ANSWER]]);
    const { items, unverified } = verifyQuotes(
      [
        item('my hypothesis was pool exhaustion'),
        item('I rewrote the connection pool in Rust', 0.9, 'Partly inferred.'),
        item(null),
        item('   '),
      ],
      answers,
    );
    expect(unverified).toBe(1);
    expect(items[0]).toMatchObject({ quote: 'my hypothesis was pool exhaustion', confidence: 0.9 });
    expect(items[1]).toMatchObject({
      quote: null,
      confidence: 0.54,
      uncertainty: `Partly inferred. ${UNVERIFIED_QUOTE_NOTE}`,
    });
    expect(items[2]!.quote).toBeNull();
    expect(items[3]).toMatchObject({ quote: null, confidence: 0.9 });
  });

  it('treats a quote citing an unknown question as unverifiable', () => {
    const { items, unverified } = verifyQuotes([item('pool exhaustion')], new Map());
    expect(unverified).toBe(1);
    expect(items[0]!.uncertainty).toBe(UNVERIFIED_QUOTE_NOTE);
  });
});
