import type { OutputLanguage } from '../evaluation/language.js';

/**
 * Practice nudge emails, in the candidate's preferred language. The product
 * name and links stay as they are in every language. Every nudge ends with
 * the one-click unsubscribe link.
 */

export type NudgeKind = 'STREAK_AT_RISK' | 'COMEBACK';

interface NudgeEmail {
  subject: string;
  text: string;
}

const SIGNATURE = 'CareerPilot Interview by CodeBegun';

const MESSAGES: Record<
  OutputLanguage,
  Record<NudgeKind, (streak: number) => NudgeEmail> & {
    open: string;
    unsubscribe: string;
  }
> = {
  en: {
    STREAK_AT_RISK: (streak) => ({
      subject: `Keep your ${streak}-day practice streak going`,
      text: `You have practised ${streak} days in a row. A quick 5-minute drill today keeps your streak alive.`,
    }),
    COMEBACK: () => ({
      subject: 'A quick drill to get back into practice',
      text: 'It has been a few days since your last practice. A 5-minute drill on one skill from your plan is an easy way to pick up where you left off.',
    }),
    open: 'Open your progress',
    unsubscribe: 'Stop these emails',
  },
  hi: {
    STREAK_AT_RISK: (streak) => ({
      subject: `अपनी ${streak} दिन की अभ्यास लय बनाए रखें`,
      text: `आपने लगातार ${streak} दिन अभ्यास किया है। आज 5 मिनट की एक छोटी ड्रिल से आपकी लय बनी रहेगी।`,
    }),
    COMEBACK: () => ({
      subject: 'फिर से अभ्यास शुरू करने के लिए एक छोटी ड्रिल',
      text: 'आपके पिछले अभ्यास को कुछ दिन हो गए हैं। अपनी योजना के किसी एक कौशल पर 5 मिनट की ड्रिल से आप वहीं से आगे बढ़ सकते हैं जहाँ आपने छोड़ा था।',
    }),
    open: 'अपनी प्रगति देखें',
    unsubscribe: 'ये ईमेल बंद करें',
  },
  te: {
    STREAK_AT_RISK: (streak) => ({
      subject: `మీ ${streak} రోజుల ప్రాక్టీస్ వరుసను కొనసాగించండి`,
      text: `మీరు వరుసగా ${streak} రోజులు ప్రాక్టీస్ చేశారు. ఈ రోజు 5 నిమిషాల చిన్న డ్రిల్‌తో మీ వరుస కొనసాగుతుంది.`,
    }),
    COMEBACK: () => ({
      subject: 'మళ్లీ ప్రాక్టీస్ మొదలుపెట్టడానికి ఒక చిన్న డ్రిల్',
      text: 'మీ చివరి ప్రాక్టీస్‌కు కొన్ని రోజులైంది. మీ ప్రణాళికలోని ఒక నైపుణ్యంపై 5 నిమిషాల డ్రిల్‌తో మీరు ఆపిన చోటు నుంచే కొనసాగించవచ్చు.',
    }),
    open: 'మీ పురోగతిని చూడండి',
    unsubscribe: 'ఈ ఈమెయిల్స్ ఆపండి',
  },
};

export function nudgeEmail(
  language: OutputLanguage,
  kind: NudgeKind,
  input: { streak: number; appLink: string; unsubscribeLink: string },
): NudgeEmail {
  const m = MESSAGES[language] ?? MESSAGES.en;
  const body = m[kind](input.streak);
  return {
    subject: body.subject,
    text: `${body.text}\n\n${m.open}: ${input.appLink}\n\n${SIGNATURE}\n\n${m.unsubscribe}: ${input.unsubscribeLink}`,
  };
}
