import type { OutputLanguage } from './language.js';

/**
 * Result emails in the candidate's interview language. The product name,
 * the link and "7" stay as they are in every language.
 */

const SIGNATURE = 'CareerPilot Interview by CodeBegun';

interface ResultEmail {
  subject: string;
  text: string;
}

const SUBMITTED: Record<OutputLanguage, ResultEmail> = {
  en: {
    subject: 'Your interview has been submitted',
    text: 'Thank you for completing your interview. It has been evaluated and shared with the company that invited you, which will contact you about next steps.',
  },
  hi: {
    subject: 'आपका इंटरव्यू जमा हो गया है',
    text: 'इंटरव्यू पूरा करने के लिए धन्यवाद। इसका मूल्यांकन हो चुका है और इसे उस कंपनी के साथ साझा किया गया है जिसने आपको आमंत्रित किया था। अगले चरणों के बारे में वही आपसे संपर्क करेगी।',
  },
  te: {
    subject: 'మీ ఇంటర్వ్యూ సమర్పించబడింది',
    text: 'ఇంటర్వ్యూ పూర్తి చేసినందుకు ధన్యవాదాలు. దీని మూల్యాంకనం పూర్తయింది మరియు మిమ్మల్ని ఆహ్వానించిన కంపెనీతో పంచుకోబడింది. తదుపరి దశల గురించి ఆ కంపెనీ మిమ్మల్ని సంప్రదిస్తుంది.',
  },
};

const READY: Record<OutputLanguage, (link: string) => ResultEmail> = {
  en: (link) => ({
    subject: 'Your interview readiness report is ready',
    text: `Your practice interview has been evaluated.\n\nOpen your report: ${link}\n\nIt includes your readiness by area, the evidence behind it and a 7-day practice plan.`,
  }),
  hi: (link) => ({
    subject: 'आपकी इंटरव्यू रेडीनेस रिपोर्ट तैयार है',
    text: `आपके अभ्यास इंटरव्यू का मूल्यांकन हो गया है।\n\nअपनी रिपोर्ट देखें: ${link}\n\nइसमें हर क्षेत्र में आपकी तैयारी, उसके पीछे के प्रमाण और 7 दिन की अभ्यास योजना शामिल है।`,
  }),
  te: (link) => ({
    subject: 'మీ ఇంటర్వ్యూ సంసిద్ధత నివేదిక సిద్ధంగా ఉంది',
    text: `మీ ప్రాక్టీస్ ఇంటర్వ్యూ మూల్యాంకనం పూర్తయింది.\n\nమీ నివేదికను చూడండి: ${link}\n\nఇందులో ప్రతి అంశంలో మీ సంసిద్ధత, దానికి ఆధారాలు మరియు 7 రోజుల ప్రాక్టీస్ ప్రణాళిక ఉన్నాయి.`,
  }),
};

/** "Submitted" notice for campaign interviews whose report the candidate does not see. */
export function submittedEmail(language: OutputLanguage): ResultEmail {
  const m = SUBMITTED[language] ?? SUBMITTED.en;
  return { subject: m.subject, text: `${m.text}\n\n${SIGNATURE}` };
}

/** "Your report is ready" with the report link. */
export function reportReadyEmail(language: OutputLanguage, link: string): ResultEmail {
  const m = (READY[language] ?? READY.en)(link);
  return { subject: m.subject, text: `${m.text}\n\n${SIGNATURE}` };
}
