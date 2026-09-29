/**
 * Evidence quotes must be the candidate's own words. Models sometimes
 * paraphrase or invent a "quote"; shown in a report as the candidate's words,
 * that would misrepresent them. A quote is kept only when it can be found in
 * the answer it cites, after normalising case, punctuation and whitespace,
 * with a little tolerance for transcription slips.
 */

/** Share of a fragment's words that must appear, in order, in the answer. */
export const QUOTE_MATCH_RATIO = 0.85;
/** Fragments shorter than this must match exactly (fuzz on 2-3 words is meaningless). */
const FUZZY_MIN_WORDS = 4;
/** Confidence multiplier for evidence whose quote could not be verified. */
export const UNVERIFIED_QUOTE_CONFIDENCE = 0.6;
export const UNVERIFIED_QUOTE_NOTE =
  'The supporting quote could not be found in the answer and was removed.';

/** Lower-case words (any script), punctuation and whitespace removed. */
export function matchWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}']+/gu, ' ')
    .replace(/'/g, '')
    .split(' ')
    .filter(Boolean);
}

/** Longest common subsequence length of two short word lists. */
function lcs(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const next = new Array<number>(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j++) {
      next[j + 1] = word === b[j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, next[j]!);
    }
    prev = next;
  }
  return prev[b.length]!;
}

/** Index just past `fragment` in `words` (searching from `from`), or -1. */
function findFragment(fragment: readonly string[], words: readonly string[], from: number): number {
  const n = fragment.length;
  // Exact run first.
  for (let i = from; i + n <= words.length; i++) {
    let j = 0;
    while (j < n && words[i + j] === fragment[j]) j++;
    if (j === n) return i + n;
  }
  if (n < FUZZY_MIN_WORDS) return -1;
  // Fuzzy: a window a little wider than the fragment holding most of its words in order.
  const needed = Math.ceil(n * QUOTE_MATCH_RATIO);
  const width = n + Math.max(2, Math.ceil(n * 0.2));
  const firstWords = new Set(fragment.slice(0, n - needed + 1));
  for (let i = from; i < words.length; i++) {
    if (!firstWords.has(words[i]!)) continue;
    const window = words.slice(i, i + width);
    if (lcs(fragment, window) >= needed) return Math.min(words.length, i + n);
  }
  return -1;
}

/**
 * Whether `quote` appears in `answer`. Elided quotes ("a … b") must match
 * each fragment in order.
 */
export function quoteFound(quote: string, answer: string): boolean {
  const words = matchWords(answer);
  const fragments = quote
    .split(/\.{3}|…|\[\s*\.*\s*\]/)
    .map(matchWords)
    .filter((f) => f.length > 0);
  if (fragments.length === 0 || words.length === 0) return false;
  let from = 0;
  for (const fragment of fragments) {
    const end = findFragment(fragment, words, from);
    if (end < 0) return false;
    from = end;
  }
  return true;
}

export interface QuotedEvidence {
  questionId: string;
  confidence: number;
  quote: string | null;
  uncertainty: string | null;
}

/**
 * Checks each item's quote against the answer to its question. Unverifiable
 * quotes are removed and that item's confidence is lowered, with a note.
 * Returns the checked items and how many quotes were removed.
 */
export function verifyQuotes<T extends QuotedEvidence>(
  items: readonly T[],
  answers: ReadonlyMap<string, string>,
): { items: T[]; unverified: number } {
  let unverified = 0;
  const checked = items.map((item) => {
    const quote = item.quote?.trim() ? item.quote.trim() : null;
    if (quote === null) return { ...item, quote: null };
    if (quoteFound(quote, answers.get(item.questionId) ?? '')) return { ...item, quote };
    unverified += 1;
    return {
      ...item,
      quote: null,
      confidence: Math.round(item.confidence * UNVERIFIED_QUOTE_CONFIDENCE * 100) / 100,
      uncertainty: item.uncertainty
        ? `${item.uncertainty} ${UNVERIFIED_QUOTE_NOTE}`.slice(0, 200)
        : UNVERIFIED_QUOTE_NOTE,
    };
  });
  return { items: checked, unverified };
}
