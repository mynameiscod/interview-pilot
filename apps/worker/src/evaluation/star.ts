import {
  STAR_PARTS,
  type QuestionFeedback,
  type RoundType,
  type StarCoverage,
  type StructureInsight,
} from '@cbi/shared-types';

/**
 * STAR structure (Situation, Task, Action, Result) of behavioural answers.
 * The coaching model reports it when available; otherwise these cue phrases
 * give a deterministic estimate. Coaching only: STAR never changes a score.
 */

/** Cue phrases per part, matched case-insensitively on word boundaries (English, Hindi, Telugu). */
export const STAR_CUES: Readonly<Record<keyof StarCoverage, readonly string[]>> = {
  situation: [
    'when i was',
    'at my previous',
    'at my last',
    'in my previous',
    'in my last',
    'in my current',
    'at the time',
    'the situation',
    'the context',
    'background',
    'we had a',
    'there was a',
    'last year',
    'while working',
    'during a',
    'during my',
    'once',
    'जब मैं',
    'उस समय',
    'पिछली कंपनी',
    'पिछले प्रोजेक्ट',
    'ఆ సమయంలో',
    'నేను పని చేస్తున్నప్పుడు',
    'మా టీమ్',
    'మా ప్రాజెక్ట్',
  ],
  task: [
    'my role',
    'my job was',
    'i was responsible',
    'my responsibility',
    'i needed to',
    'i had to',
    'we needed to',
    'we had to',
    'the goal',
    'our goal',
    'my goal',
    'the task',
    'objective',
    'i was asked to',
    'i was tasked',
    'challenge was',
    'मेरी ज़िम्मेदारी',
    'मेरी जिम्मेदारी',
    'मुझे करना था',
    'लक्ष्य',
    'నా బాధ్యత',
    'లక్ష్యం',
    'నేను చేయాల్సింది',
  ],
  action: [
    'i decided',
    'i implemented',
    'i built',
    'i created',
    'i designed',
    'i wrote',
    'i led',
    'i organised',
    'i organized',
    'i spoke',
    'i talked',
    'i set up',
    'i proposed',
    'i started',
    'i changed',
    'i added',
    'i fixed',
    'i worked with',
    'i reached out',
    'i asked',
    'i analysed',
    'i analyzed',
    'i then',
    'so i',
    'first i',
    'मैंने',
    'చేశాను',
    'నిర్ణయించాను',
    'మాట్లాడాను',
  ],
  result: [
    'as a result',
    'the result',
    'resulted in',
    'the outcome',
    'which led to',
    'this led to',
    'reduced',
    'increased',
    'improved',
    'saved',
    'we delivered',
    'we launched',
    'shipped',
    'in the end',
    'finally',
    'percent',
    'i learned',
    'i learnt',
    'the feedback',
    'नतीजा',
    'परिणाम',
    'जिससे',
    'सीखा',
    'ఫలితం',
    'దీని వల్ల',
    'తగ్గింది',
    'పెరిగింది',
    'నేర్చుకున్నాను',
  ],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CUE_PATTERNS = Object.fromEntries(
  Object.entries(STAR_CUES).map(([part, cues]) => [
    part,
    // \p{L}\p{M} boundaries so Devanagari and Telugu cues match whole words too.
    new RegExp(`(?<![\\p{L}\\p{M}])(?:${cues.map(escape).join('|')})(?![\\p{L}\\p{M}])`, 'iu'),
  ]),
) as Record<keyof StarCoverage, RegExp>;

/** Deterministic STAR estimate from cue phrases; a percentage also counts as a result. */
export function detectStar(answer: string): StarCoverage {
  const text = answer.normalize('NFC').replace(/[’‘]/g, "'");
  return {
    situation: CUE_PATTERNS.situation.test(text),
    task: CUE_PATTERNS.task.test(text),
    action: CUE_PATTERNS.action.test(text),
    result: CUE_PATTERNS.result.test(text) || /\d\s?%/.test(text),
  };
}

/** A behavioural question: the behavioural round, or a behavioural competency elsewhere. */
export const isBehavioural = (roundType: RoundType, category: string | null | undefined) =>
  roundType === 'BEHAVIORAL' || category === 'BEHAVIORAL';

/** STAR across the interview's behavioural answers; null when there were none. */
export function structureInsight(
  questions: readonly Pick<QuestionFeedback, 'star'>[],
): StructureInsight | null {
  const stars = questions.flatMap((q) => (q.star ? [q.star] : []));
  if (stars.length === 0) return null;
  const counts = Object.fromEntries(
    STAR_PARTS.map((part) => [part, stars.filter((s) => s[part]).length]),
  ) as StructureInsight['counts'];
  const lowest = Math.min(...STAR_PARTS.map((p) => counts[p]));
  return {
    behaviouralAnswers: stars.length,
    complete: stars.filter((s) => STAR_PARTS.every((p) => s[p])).length,
    counts,
    // Ties go to the later part: a missing result is the more common and costlier gap.
    weakest:
      lowest === stars.length ? null : [...STAR_PARTS].reverse().find((p) => counts[p] === lowest)!,
  };
}
