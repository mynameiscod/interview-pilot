import { z } from 'zod';

/**
 * Speech delivery analytics for spoken (voice and video) answers: pace,
 * filler words, long pauses and hedging. They are coaching only and never
 * affect a competency score: pace and fillers vary with accent, language,
 * nerves and speech differences, and the transcript already carries the
 * content that is scored. Every word list lives here so it can be tuned in
 * one place.
 */

/** Targets shown next to the metrics (and used to pick tips). */
export const DELIVERY_TARGETS = {
  /** A comfortable interview pace, in words per minute. */
  wpm: { min: 120, max: 160 },
  /** Filler words per 100 words above which a tip is shown. */
  maxFillersPer100: 3,
  /** A silence between words at least this long is a long pause. */
  longPauseSec: 2,
  /** Long pauses per minute of speech above which a tip is shown. */
  maxLongPausesPerMinute: 1,
  /** Hedging phrases per 100 words above which a tip is shown. */
  maxHedgesPer100: 2,
} as const;

/** Answers shorter than this give no pace (too little speech to measure). */
const MIN_PACE_WORDS = 5;
const MIN_PACE_SEC = 3;

/**
 * How a listed word counts:
 * - ALWAYS: every occurrence.
 * - DELIMITED: only when set off by punctuation (", like,"), not merely at the
 *   start of a sentence — these words are
 *   also ordinary words ("I like Go", "वो" as a pronoun).
 * - LEADING: at the start of a sentence, or followed by a comma ("So, …").
 */
export type FillerRule = 'ALWAYS' | 'DELIMITED' | 'LEADING';

export interface PhraseEntry {
  /** Lower-case words, space separated. */
  text: string;
  rule: FillerRule;
  /** Not counted after these words ("do you know" is a question, not a filler). */
  notAfter?: readonly string[];
}

export type DeliveryLanguage = 'en' | 'hi' | 'te';

const always = (...texts: string[]): PhraseEntry[] =>
  texts.map((text) => ({ text, rule: 'ALWAYS' }));
const delimited = (...texts: string[]): PhraseEntry[] =>
  texts.map((text) => ({ text, rule: 'DELIMITED' }));

/** Filler words per language (Latin transliterations included for Hindi and Telugu). */
export const FILLER_WORDS: Readonly<Record<DeliveryLanguage, readonly PhraseEntry[]>> = {
  en: [
    ...always('um', 'umm', 'uh', 'uhh', 'er', 'erm', 'basically', 'actually'),
    { text: 'you know', rule: 'ALWAYS', notAfter: ['do', 'did', 'if', 'dont', 'didnt'] },
    ...delimited('like'),
    { text: 'so', rule: 'LEADING' },
  ],
  hi: [
    ...always('matlab', 'yaani', 'yani', 'मतलब', 'यानी', 'यानि'),
    ...delimited('haan', 'woh', 'wo', 'हाँ', 'हां', 'वो'),
  ],
  te: [...always('ante', 'అంటే'), ...delimited('ala', 'aa', 'adi', 'అలా', 'ఆ', 'అది')],
};

/** Hedging phrases: they soften claims and can make strong experience sound unsure. */
export const HEDGING_PHRASES: Readonly<Record<DeliveryLanguage, readonly PhraseEntry[]>> = {
  en: always(
    'i think',
    'i guess',
    'i suppose',
    'maybe',
    'perhaps',
    'probably',
    'kind of',
    'sort of',
    'im not sure',
    'i am not sure',
    'hopefully',
  ),
  hi: always('shayad', 'lagta hai', 'शायद', 'लगता है', 'पता नहीं'),
  te: always('emo', 'anukunta', 'ఏమో', 'అనుకుంటా', 'అనుకుంటాను'),
};

// ---- Contracts --------------------------------------------------------------------------------

const Count = z.object({ text: z.string(), count: z.number().int() });

/** Delivery metrics of one spoken answer (stored with the answer). */
export const DeliveryMetrics = z.object({
  /** Recording length. */
  durationSec: z.number(),
  wordCount: z.number().int(),
  /** Null when the answer is too short to measure. */
  wpm: z.number().int().nullable(),
  fillerCount: z.number().int(),
  /** Filler words per 100 words (one decimal). */
  fillerRate: z.number(),
  topFillers: z.array(Count).max(3),
  /** Silences of at least 2 s between words; null without word timestamps. */
  longPauses: z.number().int().nullable(),
  longestPauseSec: z.number().nullable(),
  hedgeCount: z.number().int(),
  topHedges: z.array(Count).max(3),
  /** Pace and pauses came from word timestamps (otherwise from the recording length). */
  timestamps: z.boolean(),
});
export type DeliveryMetrics = z.infer<typeof DeliveryMetrics>;

export const DeliveryTip = z.enum(['PACE_FAST', 'PACE_SLOW', 'FILLERS', 'PAUSES', 'HEDGING']);
export type DeliveryTip = z.infer<typeof DeliveryTip>;

/** Totals over every spoken answer of an interview. */
export const DeliverySummary = z.object({
  answers: z.number().int(),
  durationSec: z.number(),
  wordCount: z.number().int(),
  wpm: z.number().int().nullable(),
  fillerCount: z.number().int(),
  fillerRate: z.number(),
  topFillers: z.array(Count).max(3),
  /** Null when no answer had word timestamps. */
  longPauses: z.number().int().nullable(),
  hedgeCount: z.number().int(),
  topHedges: z.array(Count).max(3),
});
export type DeliverySummary = z.infer<typeof DeliverySummary>;

/** The report's Delivery section (only for interviews with spoken answers). */
export const ReportDelivery = z.object({
  summary: DeliverySummary,
  tips: z.array(DeliveryTip),
  answers: z.array(
    z.object({ questionId: z.string(), seq: z.number().int(), metrics: DeliveryMetrics }),
  ),
});
export type ReportDelivery = z.infer<typeof ReportDelivery>;

// ---- Computation ----------------------------------------------------------------------------

interface Token {
  word: string;
  /** Sentence punctuation (or the start) before the word. */
  sentenceStart: boolean;
  /** Any punctuation (comma, dash, sentence end) or the start before it / punctuation after it. */
  breakBefore: boolean;
  breakAfter: boolean;
}

const WORD = /[\p{L}\p{M}\p{N}'’]+/gu;

/** Words of a transcript with the punctuation around them. */
export function deliveryTokens(raw: string): Token[] {
  const text = raw.normalize('NFC');
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(WORD)) {
    const gap = text.slice(last, match.index);
    const previous = tokens.at(-1);
    const punct = /[,;:—–\-.!?।…]/.test(gap);
    if (previous) previous.breakAfter = punct;
    tokens.push({
      word: match[0].toLowerCase().replace(/['’]/g, ''),
      sentenceStart: !previous || /[.!?।…]/.test(gap),
      breakBefore: !previous || punct,
      breakAfter: false,
    });
    last = match.index + match[0].length;
  }
  const final = tokens.at(-1);
  if (final) final.breakAfter = /[,;:—–\-.!?।…]/.test(text.slice(last));
  return tokens;
}

function countPhrases(tokens: readonly Token[], entries: readonly PhraseEntry[]) {
  const phrases = entries
    .map((e) => ({ ...e, words: e.text.split(' ') }))
    .sort((a, b) => b.words.length - a.words.length);
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < tokens.length; i++) {
    for (const p of phrases) {
      const n = p.words.length;
      if (i + n > tokens.length || p.words.some((w, j) => tokens[i + j]!.word !== w)) continue;
      const first = tokens[i]!;
      const lastToken = tokens[i + n - 1]!;
      if (p.notAfter && i > 0 && p.notAfter.includes(tokens[i - 1]!.word)) continue;
      // Mid-sentence punctuation before, or any after: "it was, like, fine" but not "Like I said".
      if (
        p.rule === 'DELIMITED' &&
        !(first.breakBefore && !first.sentenceStart) &&
        !lastToken.breakAfter
      )
        continue;
      if (
        p.rule === 'LEADING' &&
        !first.sentenceStart &&
        !(lastToken.breakAfter && i + n < tokens.length)
      )
        continue;
      counts.set(p.text, (counts.get(p.text) ?? 0) + 1);
      total += 1;
      i += n - 1;
      break;
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([text, count]) => ({ text, count }));
  return { total, top };
}

/** English always applies (answers mix languages); Hindi or Telugu lists are added for those answers. */
function listsFor(language: string | null | undefined) {
  const lang = (language ?? '').toLowerCase().slice(0, 2);
  const extra = lang === 'hi' || lang === 'te' ? [lang] : [];
  return (['en', ...extra] as DeliveryLanguage[]).map((l) => ({
    fillers: FILLER_WORDS[l],
    hedges: HEDGING_PHRASES[l],
  }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const per100 = (count: number, words: number) => (words > 0 ? round1((count * 100) / words) : 0);

function mergeTop(lists: readonly { text: string; count: number }[][]) {
  const counts = new Map<string, number>();
  for (const list of lists)
    for (const x of list) counts.set(x.text, (counts.get(x.text) ?? 0) + x.count);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([text, count]) => ({ text, count }));
}

export interface TimedWord {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
}

/**
 * Delivery metrics of one spoken answer from its transcript, the recording
 * length and (when the speech model returns them) word timestamps. Pure.
 */
export function deliveryMetrics(input: {
  text: string;
  durationSec: number;
  words?: readonly TimedWord[] | null;
  language?: string | null;
}): DeliveryMetrics {
  const tokens = deliveryTokens(input.text);
  const words = (input.words ?? []).filter(
    (w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start,
  );
  const timestamps = words.length >= 2;
  const lists = listsFor(input.language);
  const fillers = lists.map((l) => countPhrases(tokens, l.fillers));
  const hedges = lists.map((l) => countPhrases(tokens, l.hedges));
  const fillerCount = fillers.reduce((n, f) => n + f.total, 0);
  const hedgeCount = hedges.reduce((n, h) => n + h.total, 0);

  let longPauses: number | null = null;
  let longestPauseSec: number | null = null;
  let speakingSec = input.durationSec;
  if (timestamps) {
    longPauses = 0;
    longestPauseSec = 0;
    for (let i = 1; i < words.length; i++) {
      const gap = words[i]!.start - words[i - 1]!.end;
      if (gap >= DELIVERY_TARGETS.longPauseSec) longPauses += 1;
      longestPauseSec = Math.max(longestPauseSec, gap);
    }
    longestPauseSec = round1(longestPauseSec);
    // Pace over the speech itself: silence before the first and after the last word is not counted.
    speakingSec = words.at(-1)!.end - words[0]!.start;
  }
  const measurable = tokens.length >= MIN_PACE_WORDS && speakingSec >= MIN_PACE_SEC;
  return {
    durationSec: round1(input.durationSec),
    wordCount: tokens.length,
    wpm: measurable ? Math.round(tokens.length / (speakingSec / 60)) : null,
    fillerCount,
    fillerRate: per100(fillerCount, tokens.length),
    topFillers: mergeTop(fillers.map((f) => f.top)),
    longPauses,
    longestPauseSec,
    hedgeCount,
    topHedges: mergeTop(hedges.map((h) => h.top)),
    timestamps,
  };
}

/** Interview totals: pace weighted by each answer's words and time. */
export function summarizeDelivery(answers: readonly DeliveryMetrics[]): DeliverySummary {
  const paced = answers.filter((a) => a.wpm !== null && a.wpm > 0);
  const pacedWords = paced.reduce((n, a) => n + a.wordCount, 0);
  const pacedMinutes = paced.reduce((n, a) => n + a.wordCount / a.wpm!, 0);
  const wordCount = answers.reduce((n, a) => n + a.wordCount, 0);
  const fillerCount = answers.reduce((n, a) => n + a.fillerCount, 0);
  const timed = answers.filter((a) => a.longPauses !== null);
  return {
    answers: answers.length,
    durationSec: round1(answers.reduce((n, a) => n + a.durationSec, 0)),
    wordCount,
    wpm: pacedMinutes > 0 ? Math.round(pacedWords / pacedMinutes) : null,
    fillerCount,
    fillerRate: per100(fillerCount, wordCount),
    topFillers: mergeTop(answers.map((a) => a.topFillers)),
    longPauses: timed.length ? timed.reduce((n, a) => n + a.longPauses!, 0) : null,
    hedgeCount: answers.reduce((n, a) => n + a.hedgeCount, 0),
    topHedges: mergeTop(answers.map((a) => a.topHedges)),
  };
}

/** Tips for the Delivery section, most useful first. Empty when everything is on target. */
export function deliveryTips(summary: DeliverySummary): DeliveryTip[] {
  const t = DELIVERY_TARGETS;
  const tips: DeliveryTip[] = [];
  if (summary.wpm !== null && summary.wpm > t.wpm.max) tips.push('PACE_FAST');
  if (summary.wpm !== null && summary.wpm < t.wpm.min) tips.push('PACE_SLOW');
  if (summary.fillerRate > t.maxFillersPer100) tips.push('FILLERS');
  const minutes = summary.durationSec / 60;
  if (
    summary.longPauses !== null &&
    minutes > 0 &&
    summary.longPauses / minutes > t.maxLongPausesPerMinute
  )
    tips.push('PAUSES');
  if (per100(summary.hedgeCount, summary.wordCount) > t.maxHedgesPer100) tips.push('HEDGING');
  return tips;
}
