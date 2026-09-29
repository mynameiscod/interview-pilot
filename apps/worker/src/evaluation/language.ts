import type { InterviewLanguagePreference } from '@cbi/shared-types';

/** Languages the report text and result emails are written in. */
export type OutputLanguage = 'en' | 'hi' | 'te';

/** The name given to the model in `{{language}}`. */
export const LANGUAGE_NAMES: Readonly<Record<OutputLanguage, string>> = {
  en: 'English',
  hi: 'Hindi',
  te: 'Telugu',
};

const DEVANAGARI = /[ऀ-ॿ]/gu;
const TELUGU = /[ఀ-౿]/gu;
const LETTER = /\p{L}/gu;

/** Share of letters needed before answers count as written in a script. */
const SCRIPT_SHARE = 0.3;

/**
 * The language for candidate-facing output: the session's language when it
 * was chosen, otherwise (auto) the script most of the answers are written
 * in. Hindi or Telugu typed in Latin letters stays English.
 */
export function outputLanguage(
  preference: InterviewLanguagePreference | null | undefined,
  answers: readonly string[] = [],
): OutputLanguage {
  if (preference === 'en' || preference === 'hi' || preference === 'te') return preference;
  const text = answers.join('\n');
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters === 0) return 'en';
  const devanagari = text.match(DEVANAGARI)?.length ?? 0;
  const telugu = text.match(TELUGU)?.length ?? 0;
  if (Math.max(devanagari, telugu) / letters < SCRIPT_SHARE) return 'en';
  return devanagari >= telugu ? 'hi' : 'te';
}
