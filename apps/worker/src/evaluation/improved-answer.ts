import { IMPROVED_ANSWER_PLACEHOLDERS } from '@cbi/shared-types';
import type { OutputLanguage } from './language.js';
import { matchWords } from './quotes.js';

/**
 * The example answer must be built from what the candidate said. Shown next
 * to their answer, an example that credits them with an employer, project
 * or result they never mentioned would teach them to claim it. After the
 * model writes it:
 * - numbers not in the answer or the question become "[your metric]";
 * - a name (a capitalised word mid-sentence) not in the answer, the question
 *   or the role withholds the example entirely, since it cannot be repaired
 *   without guessing what the name stood for.
 */

/** Capitalised words that are not names (sentence starts are skipped separately). */
const COMMON_CAPITALISED = new Set([
  'i',
  'im',
  'ive',
  'id',
  'ill',
  'situation',
  'task',
  'action',
  'result',
  'star',
  'ok',
  'okay',
]);

/** Digits, with decimals, thousands separators and a trailing % or k/m (Devanagari and Telugu digits too). */
const NUMBER = /[$₹€£]?[\d०-९౦-౯][\d०-९౦-౯,.]*\s?(?:%|percent\b|[kKmM]\b)?/gu;
const isPlaceholder = (part: string) => /^\[[^\]]*\]$/.test(part);
const LATIN_NAME = /(?<![\p{L}\p{M}'’])\p{Lu}[\p{L}\p{M}'’-]*/gu;

const digitsOf = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/[౦-౯]/g, (d) => String(d.charCodeAt(0) - 0x0c66))
    .replace(/[^\d.]/g, '')
    .replace(/\.$/, '');

export interface GroundedAnswer {
  /** The example answer to show, or null when it was withheld. */
  text: string | null;
  /** Numbers replaced by the metric placeholder. */
  replacedNumbers: number;
  /** Names the candidate never mentioned (the example is withheld when there are any). */
  ungroundedNames: string[];
}

/** Checks an example answer against the candidate's own words (see the module comment). Pure. */
export function groundImprovedAnswer(
  improved: string | null,
  sources: { answer: string; question: string; role?: string },
  language: OutputLanguage,
): GroundedAnswer {
  if (!improved?.trim()) return { text: null, replacedNumbers: 0, ungroundedNames: [] };
  const source = `${sources.answer}\n${sources.question}\n${sources.role ?? ''}`;
  const knownNumbers = new Set(
    [...source.matchAll(NUMBER)].map((m) => digitsOf(m[0])).filter(Boolean),
  );
  const knownWords = new Set(matchWords(source));
  const placeholder = IMPROVED_ANSWER_PLACEHOLDERS[language].metric;

  // Placeholders the model wrote stay untouched; numbers and names are checked outside them.
  const parts = improved.trim().split(/(\[[^\]]*\])/g);
  let replacedNumbers = 0;
  const names = new Set<string>();
  const checked = parts.map((part) => {
    if (isPlaceholder(part)) return part;
    const withMetrics = part.replace(NUMBER, (m) => {
      const digits = digitsOf(m);
      if (!digits || knownNumbers.has(digits)) return m;
      replacedNumbers += 1;
      return placeholder + (/\s$/.test(m) ? ' ' : '');
    });
    for (const match of withMetrics.matchAll(LATIN_NAME)) {
      const raw = withMetrics.slice(0, match.index);
      const before = raw.trimEnd();
      // The start of a sentence, line, list item or quoted phrase is not evidence of a name.
      const sentenceStart = before === '' || /\n\s*$/.test(raw) || /[.!?:;"“(•-]$/.test(before);
      const words = matchWords(match[0]);
      if (sentenceStart || words.length === 0) continue;
      if (words.every((w) => knownWords.has(w) || COMMON_CAPITALISED.has(w))) continue;
      names.add(match[0]);
    }
    return withMetrics;
  });
  const ungroundedNames = [...names];
  return {
    text: ungroundedNames.length ? null : checked.join('').replace(/[ \t]{2,}/g, ' '),
    replacedNumbers,
    ungroundedNames,
  };
}
