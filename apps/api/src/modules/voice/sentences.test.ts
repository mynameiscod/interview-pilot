import { describe, expect, it } from 'vitest';
import { createSentenceChunker } from './sentences.js';

/** Feeds `text` in small pieces, as a model streams it. */
function stream(text: string, size = 3, opts?: Parameters<typeof createSentenceChunker>[0]) {
  const chunker = createSentenceChunker(opts);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...chunker.push(text.slice(i, i + size)));
  out.push(...chunker.flush());
  return out;
}

describe('sentence chunker', () => {
  it('releases a sentence as soon as the next one starts', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('Tell me about a system you designed recently.')).toEqual([]);
    expect(chunker.push(' What')).toEqual(['Tell me about a system you designed recently.']);
    expect(chunker.push(' trade-offs did you make?')).toEqual([]);
    expect(chunker.flush()).toEqual(['What trade-offs did you make?']);
  });

  it('keeps abbreviations, initials and decimals inside a sentence', () => {
    expect(
      stream(
        'How would you handle retries, e.g. with backoff, in a 2.5 second budget? Dr. J. Rao asked the same thing last week.',
      ),
    ).toEqual([
      'How would you handle retries, e.g. with backoff, in a 2.5 second budget?',
      'Dr. J. Rao asked the same thing last week.',
    ]);
  });

  it('merges very short sentences into the next one', () => {
    expect(stream('Great. Now, tell me how you tested the payment flow end to end.')).toEqual([
      'Great. Now, tell me how you tested the payment flow end to end.',
    ]);
  });

  it('splits Hindi on the danda and handles closing quotes', () => {
    expect(
      stream('आपने पिछले प्रोजेक्ट में कौन सी ज़िम्मेदारी ली थी। उस "API design" पर क्या सोचा?"'),
    ).toEqual([
      'आपने पिछले प्रोजेक्ट में कौन सी ज़िम्मेदारी ली थी।',
      'उस "API design" पर क्या सोचा?"',
    ]);
  });

  it('cuts a run-on without punctuation at a word boundary', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const out = stream(words, 5, { maxChars: 60 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((s) => s.length <= 60)).toBe(true);
    expect(out.join(' ')).toBe(words);
  });

  it('returns nothing for empty input', () => {
    expect(stream('   ')).toEqual([]);
  });
});
