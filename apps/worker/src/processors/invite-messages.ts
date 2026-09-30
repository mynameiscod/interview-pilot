import type { InviteLanguage } from '@cbi/shared-types';

/**
 * Campaign invite and reminder emails, in the language the organisation
 * chose for the invitee (English, Hindi or Telugu). Company, role and
 * campaign names, the link and the product name stay as they are.
 */

const SIGNATURE = 'CareerPilot Interview by CodeBegun';

export interface InviteMessageInput {
  /** The invitee's name, when the organisation gave one. */
  name: string | null;
  companyName: string;
  roleTitle: string;
  link: string;
  /** When the campaign closes, if it has an end date. */
  endAt: Date | null;
  /** 1-based reminder number (reminders only). */
  reminder?: number;
}

interface Copy {
  greeting: (name: string | null) => string;
  inviteSubject: (company: string, role: string) => string;
  reminderSubject: (company: string, role: string) => string;
  invited: (company: string, role: string) => string;
  reminded: (company: string, role: string) => string;
  start: (link: string) => string;
  closes: (date: string) => string;
  personal: string;
  practice: string;
  dateLocale: string;
}

const COPY: Record<InviteLanguage, Copy> = {
  en: {
    greeting: (name) => (name ? `Hello ${name},` : 'Hello,'),
    inviteSubject: (company, role) => `${company} invites you to a ${role} interview`,
    reminderSubject: (company, role) => `Reminder: your ${role} interview with ${company}`,
    invited: (company, role) =>
      `${company} has invited you to an online interview for the ${role} role on CareerPilot Interview.`,
    reminded: (company, role) =>
      `This is a reminder that ${company} is waiting for your ${role} interview on CareerPilot Interview.`,
    start: (link) => `Open your personal invitation to start: ${link}`,
    closes: (date) => `The interview closes on ${date}.`,
    personal: 'This link is for you. Please do not share it.',
    practice:
      'Before you start, you can read what the interview covers and what the company will see.',
    dateLocale: 'en-IN',
  },
  hi: {
    greeting: (name) => (name ? `नमस्ते ${name},` : 'नमस्ते,'),
    inviteSubject: (company, role) => `${company} ने आपको ${role} इंटरव्यू के लिए आमंत्रित किया है`,
    reminderSubject: (company, role) => `रिमाइंडर: ${company} के साथ आपका ${role} इंटरव्यू`,
    invited: (company, role) =>
      `${company} ने आपको CareerPilot Interview पर ${role} भूमिका के ऑनलाइन इंटरव्यू के लिए आमंत्रित किया है।`,
    reminded: (company, role) =>
      `यह एक रिमाइंडर है: ${company} CareerPilot Interview पर आपके ${role} इंटरव्यू का इंतज़ार कर रही है।`,
    start: (link) => `शुरू करने के लिए अपना व्यक्तिगत आमंत्रण खोलें: ${link}`,
    closes: (date) => `इंटरव्यू ${date} को बंद हो जाएगा।`,
    personal: 'यह लिंक सिर्फ़ आपके लिए है। कृपया इसे किसी के साथ साझा न करें।',
    practice:
      'शुरू करने से पहले आप देख सकते हैं कि इंटरव्यू में क्या शामिल है और कंपनी क्या देखेगी।',
    dateLocale: 'hi-IN',
  },
  te: {
    greeting: (name) => (name ? `నమస్తే ${name},` : 'నమస్తే,'),
    inviteSubject: (company, role) => `${role} ఇంటర్వ్యూకు ${company} మిమ్మల్ని ఆహ్వానిస్తోంది`,
    reminderSubject: (company, role) => `గుర్తు: ${company} తో మీ ${role} ఇంటర్వ్యూ`,
    invited: (company, role) =>
      `CareerPilot Interview లో ${role} పాత్ర కోసం ఆన్‌లైన్ ఇంటర్వ్యూకు ${company} మిమ్మల్ని ఆహ్వానించింది.`,
    reminded: (company, role) =>
      `ఇది ఒక గుర్తు: CareerPilot Interview లో మీ ${role} ఇంటర్వ్యూ కోసం ${company} ఎదురుచూస్తోంది.`,
    start: (link) => `ప్రారంభించడానికి మీ వ్యక్తిగత ఆహ్వానాన్ని తెరవండి: ${link}`,
    closes: (date) => `ఇంటర్వ్యూ ${date} న ముగుస్తుంది.`,
    personal: 'ఈ లింక్ మీ కోసం మాత్రమే. దయచేసి దీన్ని ఎవరితోనూ పంచుకోకండి.',
    practice:
      'ప్రారంభించే ముందు, ఇంటర్వ్యూలో ఏమి ఉంటుందో మరియు కంపెనీ ఏమి చూస్తుందో మీరు చదవవచ్చు.',
    dateLocale: 'te-IN',
  },
};

function formatDate(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** The invite (no `reminder`) or a reminder email. */
export function inviteEmail(
  language: InviteLanguage,
  input: InviteMessageInput,
): { subject: string; text: string } {
  const c = COPY[language] ?? COPY.en;
  const reminder = Boolean(input.reminder);
  const lines = [
    c.greeting(input.name),
    '',
    reminder
      ? c.reminded(input.companyName, input.roleTitle)
      : c.invited(input.companyName, input.roleTitle),
    '',
    c.start(input.link),
    ...(input.endAt ? [c.closes(formatDate(input.endAt, c.dateLocale))] : []),
    '',
    c.practice,
    c.personal,
    '',
    SIGNATURE,
  ];
  return {
    subject: reminder
      ? c.reminderSubject(input.companyName, input.roleTitle)
      : c.inviteSubject(input.companyName, input.roleTitle),
    text: lines.join('\n'),
  };
}
