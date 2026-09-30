import type { EmailMessage } from '@cbi/provider-adapters';
import type { AdminRole, SessionAudience, UiLocale } from '@cbi/shared-types';

/**
 * Transactional message content. The OTP email and SMS are localised for the
 * UI locales (en / hi / te); the code, the minutes and product names
 * ("CareerPilot Interview", "CodeBegun") stay untranslated. The admin invite
 * stays English (admin console is English-only). Never include anything
 * beyond what the recipient needs.
 */

interface OtpCopy {
  subject: (code: string, product: string) => string;
  /** Sentence ending in the code, for the plain-text body. */
  codeLine: (code: string, product: string) => string;
  /** Lead-in shown above the big code in the HTML body. */
  codeIntro: (product: string) => string;
  expiry: (ttlMinutes: number) => string;
  neverShare: string;
  sms: (code: string, product: string, ttlMinutes: number) => string;
}

const OTP_COPY: Record<UiLocale, OtpCopy> = {
  en: {
    subject: (code, product) => `${code} is your ${product} code`,
    codeLine: (code, product) => `Your ${product} verification code is ${code}.`,
    codeIntro: (product) => `Your ${product} verification code is:`,
    expiry: (ttl) =>
      `It expires in ${ttl} minutes. If you did not request it, you can ignore this email.`,
    neverShare: 'CodeBegun will never ask you to share this code.',
    sms: (code, product, ttl) =>
      `${code} is your ${product} code. It expires in ${ttl} minutes. Do not share it with anyone. - CodeBegun`,
  },
  hi: {
    subject: (code, product) => `${code} आपका ${product} कोड है`,
    codeLine: (code, product) => `आपका ${product} सत्यापन कोड ${code} है।`,
    codeIntro: (product) => `आपका ${product} सत्यापन कोड है:`,
    expiry: (ttl) =>
      `यह कोड ${ttl} मिनट में समाप्त हो जाएगा। अगर आपने इसका अनुरोध नहीं किया है, तो आप इस ईमेल को अनदेखा कर सकते हैं।`,
    neverShare: 'CodeBegun आपसे यह कोड साझा करने के लिए कभी नहीं कहेगा।',
    sms: (code, product, ttl) =>
      `${code} आपका ${product} कोड है। यह ${ttl} मिनट में समाप्त होगा। इसे किसी से साझा न करें। - CodeBegun`,
  },
  te: {
    subject: (code, product) => `${code} మీ ${product} కోడ్`,
    codeLine: (code, product) => `మీ ${product} ధృవీకరణ కోడ్ ${code}.`,
    codeIntro: (product) => `మీ ${product} ధృవీకరణ కోడ్:`,
    expiry: (ttl) =>
      `ఈ కోడ్ గడువు ${ttl} నిమిషాల్లో ముగుస్తుంది. మీరు దీన్ని అభ్యర్థించకపోతే, ఈ ఈమెయిల్‌ను పట్టించుకోనవసరం లేదు.`,
    neverShare: 'ఈ కోడ్‌ను షేర్ చేయమని CodeBegun మిమ్మల్ని ఎప్పుడూ అడగదు.',
    sms: (code, product, ttl) =>
      `${code} మీ ${product} కోడ్. ఇది ${ttl} నిమిషాల్లో గడువు ముగుస్తుంది. దీన్ని ఎవరితోనూ షేర్ చేయకండి. - CodeBegun`,
  },
};

function copyFor(lang: string | undefined): { lang: UiLocale; copy: OtpCopy } {
  const key: UiLocale = lang && Object.hasOwn(OTP_COPY, lang) ? (lang as UiLocale) : 'en';
  return { lang: key, copy: OTP_COPY[key] };
}

const PRODUCT_NAME: Record<SessionAudience, string> = {
  candidate: 'CareerPilot Interview',
  admin: 'CareerPilot Interview Admin',
  org: 'CareerPilot Interview for Organisations',
};

function productName(audience: SessionAudience): string {
  return PRODUCT_NAME[audience];
}

export function otpEmail(
  to: string,
  code: string,
  ttlMinutes: number,
  audience: SessionAudience,
  lang: UiLocale = 'en',
): EmailMessage {
  const product = productName(audience);
  const { lang: resolved, copy } = copyFor(lang);
  const text = [copy.codeLine(code, product), '', copy.expiry(ttlMinutes), copy.neverShare].join(
    '\n',
  );
  const html = `<div lang="${resolved}">
<p>${copy.codeIntro(product)}</p>
<p style="font-size:24px;font-weight:600;letter-spacing:4px">${code}</p>
<p>${copy.expiry(ttlMinutes)}</p>
<p>${copy.neverShare}</p>
</div>`;
  return { to, subject: copy.subject(code, product), text, html };
}

/**
 * OTP SMS body. Used where the app controls the text (the dev mailbox). MSG91
 * sends a fixed DLT-registered template and only receives the code variable,
 * so production SMS wording/language is set in that template, not here.
 */
export function otpSms(
  code: string,
  ttlMinutes: number,
  audience: SessionAudience,
  lang: UiLocale = 'en',
): string {
  return copyFor(lang).copy.sms(code, productName(audience), ttlMinutes);
}

/** An organisation member's invitation (English, like the rest of the org portal). */
export function orgMemberInviteEmail(
  to: string,
  portalUrl: string,
  orgName: string,
  role: string,
): EmailMessage {
  const roleName = role.replace(/^ORG_/, '').toLowerCase();
  return {
    to,
    subject: `You have been invited to ${orgName} on CareerPilot Interview`,
    text: [
      `You have been invited to the ${orgName} organisation on CareerPilot Interview as a ${roleName}.`,
      '',
      `Sign in with this email address at ${portalUrl}`,
      '',
      'If you were not expecting this, you can ignore this email.',
    ].join('\n'),
  };
}

export function adminInviteEmail(to: string, adminUrl: string, roles: AdminRole[]): EmailMessage {
  const roleList = roles.map((r) => r.replace(/_/g, ' ').toLowerCase()).join(', ');
  return {
    to,
    subject: 'You have been given CareerPilot Interview admin access',
    text: [
      `You have been given admin access to CareerPilot Interview (${roleList}).`,
      '',
      `Sign in with this email address at ${adminUrl}`,
      '',
      'If you were not expecting this, please contact the CodeBegun team.',
    ].join('\n'),
  };
}
