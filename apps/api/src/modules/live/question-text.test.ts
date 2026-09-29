import { describe, expect, it } from 'vitest';
import { createQuestionTextExtractor } from './question-text.js';

function run(pieces: string[]) {
  const x = createQuestionTextExtractor();
  const revealed = pieces.map((p) => x.push(p));
  return { revealed, shown: x.shown, final: x.finish() };
}

describe('streamed question text', () => {
  it('reveals the JSON question string as it arrives, decoding escapes', () => {
    const r = run([
      '{"quest',
      'ion": "Walk me',
      ' through a \\"hard\\" bug',
      ' you fixed\\u002',
      '1"}',
    ]);
    expect(r.revealed).toEqual(['', 'Walk me', ' through a "hard" bug', ' you fixed', '!']);
    expect(r.shown).toBe('Walk me through a "hard" bug you fixed!');
    expect(r.final).toBe('Walk me through a "hard" bug you fixed!');
  });

  it('accepts fenced JSON', () => {
    const r = run(['```json\n{"question": "What did you learn from that outage?"}\n```']);
    expect(r.final).toBe('What did you learn from that outage?');
  });

  it('takes a reply that is not JSON as plain text', () => {
    const r = run(['  How do you', ' prioritise bugs against features?']);
    expect(r.revealed[0]).toBe('How do you');
    expect(r.final).toBe('How do you prioritise bugs against features?');
  });

  it('refuses unusable replies so the caller can fall back', () => {
    expect(run(['{"question": "Too short"}']).final).toBeNull();
    expect(run(['{"answer": "no question field here at all"}']).final).toBeNull();
    // Cut off before the string closed.
    expect(run(['{"question": "Tell me about the time you']).final).toBeNull();
    expect(run([]).final).toBeNull();
  });

  it('keeps a complete question even when text follows the JSON', () => {
    const r = run(['{"question": "Why did you choose Kafka over RabbitMQ?"} Hope this helps']);
    expect(r.final).toBe('Why did you choose Kafka over RabbitMQ?');
  });
});
