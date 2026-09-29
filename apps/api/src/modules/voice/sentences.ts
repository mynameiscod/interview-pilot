/**
 * Splits streamed text into sentences for speech synthesis, so the first
 * sentence can be spoken while the rest is still being written. A sentence
 * ends at `.`, `?`, `!`, `।` or `॥` (Hindi) followed by a space or a closing
 * quote or bracket, but not after a common abbreviation ("e.g.", "Dr.") or
 * inside a number ("3.5"). Very short sentences ("Great.") are kept with the
 * next one, because synthesizing tiny pieces sounds choppy and costs a
 * request each.
 */

const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'no',
  'approx',
  'dept',
  'inc',
  'ltd',
]);

const TERMINATORS = '.?!।॥';
const CLOSERS = '"\')]}”’';

/** Whether the terminator at `i` really ends a sentence (the next character is known). */
function endsSentence(text: string, i: number): boolean {
  const ch = text[i]!;
  if (ch === '.') {
    // A decimal number or a dotted abbreviation continues.
    if (/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) return false;
    const word = /([\p{L}.]+)$/u.exec(text.slice(0, i))?.[1] ?? '';
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
    // A single capital letter ("J. Smith") is an initial.
    if (/^\p{Lu}$/u.test(word)) return false;
  }
  let j = i + 1;
  while (j < text.length && (TERMINATORS.includes(text[j]!) || CLOSERS.includes(text[j]!))) j++;
  return j < text.length && /\s/.test(text[j]!);
}

export function createSentenceChunker(opts: { minChars?: number; maxChars?: number } = {}) {
  const minChars = opts.minChars ?? 24;
  // A run-on without punctuation is still spoken eventually (at a word boundary).
  const maxChars = opts.maxChars ?? 280;
  let buffer = '';
  let carried = '';

  function take(): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (!TERMINATORS.includes(buffer[i]!) || !endsSentence(buffer, i)) continue;
      let end = i + 1;
      while (
        end < buffer.length &&
        (TERMINATORS.includes(buffer[end]!) || CLOSERS.includes(buffer[end]!))
      )
        end++;
      const sentence = `${carried}${buffer.slice(start, end)}`.trim();
      start = end;
      i = end - 1;
      if (sentence.length < minChars) {
        carried = sentence;
        continue;
      }
      carried = '';
      out.push(sentence);
    }
    buffer = buffer.slice(start);
    if (`${carried}${buffer}`.length > maxChars) {
      const long = `${carried}${buffer}`;
      const cut = long.lastIndexOf(' ', maxChars);
      if (cut > minChars) {
        out.push(long.slice(0, cut).trim());
        buffer = long.slice(cut + 1);
        carried = '';
      }
    }
    return out;
  }

  return {
    /** Adds streamed text; returns the sentences it completed. */
    push(text: string): string[] {
      buffer += text;
      return take();
    },
    /** The text is complete: whatever is left is the last sentence. */
    flush(): string[] {
      const rest = `${carried}${buffer}`.trim();
      buffer = '';
      carried = '';
      return rest ? [rest] : [];
    },
  };
}

export type SentenceChunker = ReturnType<typeof createSentenceChunker>;
