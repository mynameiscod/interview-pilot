/**
 * Masks personal data in resume and job-description text before it is sent
 * to an AI provider. The models never need contact details to structure a
 * resume or plan an interview, and the prompts already forbid repeating
 * them; this removes them from the request itself. Heuristic by design:
 * it errs towards masking (a masked city is harmless, a leaked phone is not).
 * The stored raw text is never changed.
 */

export type PiiKind = 'EMAIL' | 'PHONE' | 'PROFILE_URL' | 'ADDRESS' | 'NAME';

export interface RedactOptions {
  /** Names known to belong to the candidate (e.g. the profile display name). */
  names?: readonly (string | null | undefined)[];
  /** Mask links to personal profiles (LinkedIn, GitHub, ...). Default true. */
  profileUrls?: boolean;
  /** Mask lines that look like a postal address. Default true. */
  addresses?: boolean;
}

export interface RedactResult {
  text: string;
  /** How many of each kind were masked (for logs and metrics, never the values). */
  counts: Record<PiiKind, number>;
}

export const PII_PLACEHOLDER: Readonly<Record<PiiKind, string>> = {
  EMAIL: '[EMAIL]',
  PHONE: '[PHONE]',
  PROFILE_URL: '[PROFILE_URL]',
  ADDRESS: '[ADDRESS]',
  NAME: '[NAME]',
};

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;

/**
 * Phone numbers: Indian mobiles (+91 / 91 / 0 prefix optional, 10 digits
 * starting 6-9, grouped 10, 5-5 or 3-3-4), Indian landlines with an STD code
 * (0XX-XXXXXXXX), and other international numbers written with a +country
 * code. Digit boundaries keep years, amounts and ids intact.
 */
const PHONE = new RegExp(
  [
    // Indian mobile.
    String.raw`(?:(?:\+|00)?91[\s.-]?|0)?[6-9]\d{2}[\s.-]?\d{2}[\s.-]?\d{5}`,
    String.raw`(?:(?:\+|00)?91[\s.-]?|0)?[6-9]\d{2}[\s.-]?\d{3}[\s.-]?\d{4}`,
    // Indian landline with STD code.
    String.raw`\(?0\d{2,4}\)?[\s-]\d{6,8}`,
    // International: +CC then 7-12 more digits in groups.
    String.raw`\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}`,
  ]
    .map((p) => `(?<![\\d+])${p}(?!\\d)`)
    .join('|'),
  'g',
);

/** Profile links: the host plus the path that names the person. */
const PROFILE_URL =
  /(?:https?:\/\/)?(?:www\.|[a-z]{2}\.)?(?:linkedin\.com\/(?:in|pub)|github\.com|gitlab\.com|bitbucket\.org|twitter\.com|x\.com|facebook\.com|fb\.com|instagram\.com|medium\.com\/@?|dev\.to|leetcode\.com(?:\/u)?|hackerrank\.com(?:\/profile)?|codechef\.com\/users|kaggle\.com|stackoverflow\.com\/users(?:\/\d+)?|behance\.net|dribbble\.com)\/[\w.@%~-]+\/?/giu;

/**
 * Words that make a line look like a postal address. Deliberately specific:
 * "main", "block" or "tower" also appear in work descriptions.
 */
const ADDRESS_WORDS =
  /\b(?:flat|apartments?|apt|house\s*no|h\.?\s*no|plot|door\s*no|street|road|rd|lane|nagar|colony|sector|layout|marg|chowk|vihar|enclave|district|dist|mandal|taluk|tehsil|village|pin\s*code|pincode)\b/i;
/** A 6-digit Indian PIN code (optionally split 3+3). */
const PIN_CODE = /(?<!\d)[1-9]\d{2}\s?\d{3}(?!\d)/;
/** A short line ending in a PIN code: "Hyderabad, Telangana 500032". */
const ENDS_WITH_PIN = /^.{0,80}(?<!\d)[1-9]\d{2}\s?\d{3}\s*\.?$/;
/** A house or plot number: "#12", "No. 12", "Flat 4B", "12/3", "4-5-67". */
const HOUSE_NUMBER =
  /(?:#\s?\d+|\b(?:no|h\.?\s?no|door\s?no|plot\s?no|flat(?:\s?no)?)\.?\s?[:#]?\s?\d+[a-z]?\b|\b\d+\s?\/\s?\d+\b|\b\d+-\d+-\d+\b)/i;
const ADDRESS_LABEL = /^\s*(?:address|addr\.?|residence|residential address)\s*[:\-–]/i;

function maskAddresses(text: string, count: () => void): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.length > 200) return line;
      const labelled = ADDRESS_LABEL.test(line);
      const looksLike =
        ENDS_WITH_PIN.test(line.trim()) ||
        (ADDRESS_WORDS.test(line) && (PIN_CODE.test(line) || HOUSE_NUMBER.test(line)));
      if (!labelled && !looksLike) return line;
      count();
      // Keep a label such as "Address:" so the document still reads naturally.
      const label = /^\s*[\p{L} ]{2,20}:\s*/u.exec(line)?.[0] ?? '';
      return `${label}${PII_PLACEHOLDER.ADDRESS}`;
    })
    .join('\n');
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Full names first, then each part of three or more letters (e.g. "Priya" of "Priya Sharma"). */
function nameVariants(names: readonly (string | null | undefined)[]): string[] {
  const full = names
    .map((n) => n?.normalize('NFC').replace(/\s+/g, ' ').trim() ?? '')
    .filter((n) => n.length >= 3);
  const parts = full.flatMap((n) =>
    n.split(' ').filter((p) => [...p.replace(/[.'-]/g, '')].length >= 3),
  );
  return [...new Set([...full, ...parts])].sort((a, b) => b.length - a.length);
}

/** Masks e-mail addresses, phone numbers, profile links, addresses and known names. */
export function redactPii(text: string, opts: RedactOptions = {}): RedactResult {
  const counts: Record<PiiKind, number> = {
    EMAIL: 0,
    PHONE: 0,
    PROFILE_URL: 0,
    ADDRESS: 0,
    NAME: 0,
  };
  const mask = (kind: PiiKind) => () => {
    counts[kind] += 1;
    return PII_PLACEHOLDER[kind];
  };
  let out = text.normalize('NFC');
  out = out.replace(EMAIL, mask('EMAIL'));
  if (opts.profileUrls !== false) out = out.replace(PROFILE_URL, mask('PROFILE_URL'));
  out = out.replace(PHONE, mask('PHONE'));
  if (opts.addresses !== false) {
    out = maskAddresses(out, () => {
      counts.ADDRESS += 1;
    });
  }
  for (const name of nameVariants(opts.names ?? [])) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{M}\\p{N}])${escapeRegExp(name).replace(/ /g, '\\s+')}(?![\\p{L}\\p{M}\\p{N}])`,
      'giu',
    );
    out = out.replace(pattern, mask('NAME'));
  }
  return { text: out, counts };
}

/** Total masked items (for a single log field). */
export const redactedTotal = (counts: Record<PiiKind, number>) =>
  Object.values(counts).reduce((a, b) => a + b, 0);
