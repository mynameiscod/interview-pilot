import type { CodingLanguage } from '@cbi/shared-types';

/**
 * Code similarity by winnowing (Schleimer, Wilkerson and Aiken, 2003).
 * Code is reduced to a token stream where names become `V`, numbers `N`
 * and string literals `S` (keywords and operators stay), so renaming
 * variables or reformatting does not hide a copy. Hashes of every k-gram of
 * tokens are winnowed (the minimum hash of each window of w k-grams) into
 * fingerprints, and two submissions are compared by their fingerprint sets.
 * The result is an observation for reviewers, never a score.
 */

export const SIMILARITY_ALGORITHM_VERSION = 1;
/** Tokens per k-gram; shorter matches are noise (every loop looks alike). */
export const K = 7;
/** K-grams per window: any match of at least W + K - 1 tokens is always detected. */
export const WINDOW = 4;
/** Fewer fingerprints than this (after removing the starter code's) is too little code to compare. */
export const MIN_FINGERPRINTS = 12;
export const DEFAULT_THRESHOLD = 0.8;

/** Keywords keep their meaning; every other name becomes `V`. */
const PROGRAM_KEYWORDS = new Set(
  (
    'abstract and as assert async await auto bool boolean break byte case catch char class const constexpr continue ' +
    'def default defer del delete do double elif else enum except explicit export extends extern false final finally ' +
    'float fn for foreach from func fun function go goto if impl implements import in include inline instanceof int ' +
    'interface is lambda let long loop match mod mut namespace new nil none not null object or override package ' +
    'pass private protected pub public raise readonly ref return self short signed sizeof static struct super ' +
    'switch template this throw throws trait true try type typedef typeof uint union unsigned use using val var ' +
    'virtual void volatile when where while with yield'
  ).split(' '),
);
const SQL_KEYWORDS = new Set(
  (
    'all and as asc avg between by case coalesce count cross desc distinct else end exists from full group having ' +
    'in inner insert into is join left like limit max min not null offset on or order outer over partition rank ' +
    'dense_rank row_number right select sum then union values when where window with'
  ).split(' '),
);

const TOKEN =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\d[\w.]*)|([A-Za-z_$][\w$]*)|(==|!=|<=|>=|&&|\|\||\+\+|--|->|=>|::|<<|>>|\+=|-=|\*=|\/=|[^\s\w])/g;

/** Removes comments (`//`, `/* *\/`, `#` and SQL's `--`), leaving strings alone. */
export function stripComments(code: string, language: CodingLanguage): string {
  const hash = language === 'python';
  const dashDash = language === 'sql';
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else if (
      (ch === '/' && next === '/') ||
      (hash && ch === '#') ||
      (dashDash && ch === '-' && next === '-')
    ) {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The normalised token stream of a program. */
export function tokens(code: string, language: CodingLanguage): string[] {
  const out: string[] = [];
  const sql = language === 'sql';
  const keywords = sql ? SQL_KEYWORDS : PROGRAM_KEYWORDS;
  for (const m of stripComments(code, language).matchAll(TOKEN)) {
    if (m[1] !== undefined) out.push('S');
    else if (m[2] !== undefined) out.push('N');
    else if (m[3] !== undefined) {
      // SQL keywords are case-insensitive; program keywords are not.
      const word = sql ? m[3].toLowerCase() : m[3];
      out.push(keywords.has(word) ? word : 'V');
    }
    // Statement separators vary with style; everything else stays.
    else if (m[4] !== undefined && m[4] !== ';') out.push(m[4]);
  }
  return out;
}

/** 32-bit FNV-1a of a k-gram. */
function hash(parts: readonly string[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The winnowed fingerprints of a program (a set of k-gram hashes). */
export function fingerprints(code: string, language: CodingLanguage): Set<number> {
  const toks = tokens(code, language);
  const grams: number[] = [];
  for (let i = 0; i + K <= toks.length; i++) grams.push(hash(toks.slice(i, i + K)));
  const picked = new Set<number>();
  if (grams.length === 0) return picked;
  if (grams.length < WINDOW) {
    picked.add(Math.min(...grams));
    return picked;
  }
  for (let i = 0; i + WINDOW <= grams.length; i++) {
    // The rightmost minimum of each window.
    let best = i;
    for (let j = i + 1; j < i + WINDOW; j++) if (grams[j]! <= grams[best]!) best = j;
    picked.add(grams[best]!);
  }
  return picked;
}

export interface SimilarityScore {
  /** Shared fingerprints over all fingerprints of both (Jaccard, 0–1). */
  similarity: number;
  /** Shared fingerprints over the smaller submission's (0–1): one copied into a longer one. */
  containment: number;
  /** Fingerprints compared (after the starter code's were removed). */
  compared: number;
}

/**
 * How alike two submissions are, ignoring what both got from the starter
 * code. Null when either has too little of its own code to compare.
 */
export function compareSubmissions(
  a: string,
  b: string,
  language: CodingLanguage,
  starter = '',
): SimilarityScore | null {
  const common = fingerprints(starter, language);
  const fa = [...fingerprints(a, language)].filter((h) => !common.has(h));
  const fb = new Set([...fingerprints(b, language)].filter((h) => !common.has(h)));
  if (fa.length < MIN_FINGERPRINTS || fb.size < MIN_FINGERPRINTS) return null;
  const shared = fa.filter((h) => fb.has(h)).length;
  const union = fa.length + fb.size - shared;
  return {
    similarity: Math.round((shared / union) * 1000) / 1000,
    containment: Math.round((shared / Math.min(fa.length, fb.size)) * 1000) / 1000,
    compared: union,
  };
}
