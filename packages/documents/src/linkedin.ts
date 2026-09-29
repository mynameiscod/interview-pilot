import type { ResumeStructured } from '@cbi/shared-types';

/**
 * LinkedIn profiles as a resume source, without ever contacting linkedin.com:
 * the "Save to PDF" export (More → Save to PDF) and profile text the
 * candidate copies and pastes. Both are parsed deterministically into
 * `ResumeStructured`; contact details (the Contact block, the name) are
 * skipped by design.
 */

export type LinkedInVariant = 'PDF_EXPORT' | 'PASTED';

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const POINT = `(?:${MONTH}\\s+)?\\d{4}`;
/** "January 2022 - Present (2 years 9 months)" (PDF) or "Jan 2022 - Present · 2 yrs 9 mos" (web). */
const DATE_RANGE = new RegExp(
  `^(${POINT})\\s*[-–—]\\s*(present|${POINT})\\s*(?:\\(([^)]*)\\)|·\\s*(.*))?$`,
  'i',
);
/** A company's total tenure line above grouped roles: "3 years 2 months" / "3 yrs 2 mos". */
const DURATION_ONLY = /^(?:\d+\s+(?:years?|yrs?|months?|mos?)\s*){1,2}$/i;
const PAGE_MARKER = /^page \d+ of \d+$/i;
const BULLET = /^[•·▪◦‣*-]\s*/;

/** Section headings of the PDF export (sidebar and main column) and of the web profile. */
const PDF_SIDEBAR = [
  'contact',
  'top skills',
  'languages',
  'certifications',
  'honors-awards',
  'publications',
  'patents',
];
const PDF_MAIN = ['summary', 'experience', 'education'];
const WEB_HEADINGS = [
  'about',
  'experience',
  'education',
  'skills',
  'licenses & certifications',
  'projects',
  'volunteering',
  'languages',
  'honors & awards',
  'recommendations',
  'interests',
  'activity',
  'publications',
  'courses',
];

const lower = (s: string) => s.trim().toLowerCase();

function cleanLines(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !PAGE_MARKER.test(l));
  // Copied web profiles repeat many lines (visible text plus screen-reader text).
  return lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
}

/** Which LinkedIn format the text is, or null for any other resume. */
export function detectLinkedInProfile(text: string): LinkedInVariant | null {
  const lines = cleanLines(text);
  const set = new Set(lines.map(lower));
  const hasExperience = set.has('experience');
  const dated = lines.filter((l) => DATE_RANGE.test(l));
  if (!hasExperience && dated.length === 0) return null;
  // The PDF export: a "Top Skills" sidebar or a profile link, plus "(N years M months)" durations.
  const profileLink = /linkedin\.com\/in\//i.test(text);
  const pdfDurations = dated.some((l) =>
    /\((?:less than a year|\d+ (?:years?|months?)).*\)$/i.test(l),
  );
  if (hasExperience && (set.has('top skills') || profileLink) && pdfDurations) return 'PDF_EXPORT';
  // Pasted web profile: "About" plus "· 2 yrs 9 mos" style durations.
  const webDurations = dated.some((l) => /·\s*(?:less than a year|\d+ (?:yrs?|mos?))/i.test(l));
  if (hasExperience && (set.has('about') || profileLink) && webDurations) return 'PASTED';
  return null;
}

type YearMonth = string | null;

function point(raw: string): YearMonth {
  const m = /^(?:([a-z]+)\s+)?(\d{4})$/i.exec(raw.trim());
  if (!m) return null;
  const month = m[1] ? MONTHS[m[1].toLowerCase().slice(0, 3)] : undefined;
  return month ? `${m[2]}-${String(month).padStart(2, '0')}` : m[2]!;
}

function parseRange(line: string) {
  const m = DATE_RANGE.exec(line);
  if (!m) return null;
  const current = /present/i.test(m[2]!);
  return { start: point(m[1]!), end: current ? null : point(m[2]!), current };
}

const monthIndex = (ym: string, endOfYear: boolean) => {
  const [y, m] = ym.split('-').map(Number);
  return y! * 12 + ((m ?? (endOfYear ? 12 : 1)) - 1);
};

/** Professional years from the dated roles, overlapping periods counted once. */
export function experienceYears(
  roles: readonly { start: YearMonth; end: YearMonth; current: boolean }[],
  now: Date,
): number | null {
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans = roles
    .filter((r) => r.start)
    .map(
      (r) =>
        [
          monthIndex(r.start!, false),
          r.current || !r.end ? nowIndex : monthIndex(r.end, true),
        ] as const,
    )
    .filter(([a, b]) => b >= a)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return null;
  let months = 0;
  let [start, end] = spans[0]!;
  for (const [a, b] of spans.slice(1)) {
    if (a <= end + 1) end = Math.max(end, b);
    else {
      months += end - start + 1;
      [start, end] = [a, b];
    }
  }
  months += end - start + 1;
  return Math.min(60, Math.round((months / 12) * 10) / 10);
}

/** Joins wrapped lines into highlights; a bullet or a sentence end starts a new one. */
function highlights(lines: readonly string[]): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of lines) {
    const bulleted = BULLET.test(line);
    const text = line.replace(BULLET, '');
    if (!current) current = text;
    else if (bulleted || /[.!?:]$/.test(current)) {
      out.push(current);
      current = text;
    } else current = `${current} ${text}`;
  }
  if (current) out.push(current);
  return out.map((h) => h.slice(0, 300)).slice(0, 8);
}

/** Short, unpunctuated lines are names (companies, schools); descriptions are sentences. */
const looksLikeName = (line: string) =>
  line.length <= 70 && !/[.!?]$/.test(line) && !BULLET.test(line) && !DATE_RANGE.test(line);
const looksLikeLocation = (line: string) =>
  line.length <= 60 &&
  !/[.!?]$/.test(line) &&
  (/,/.test(line) || /\b(remote|area|india|hybrid|on-site)\b/i.test(line));

function section(lines: readonly string[], start: number, headings: readonly string[]) {
  let end = start + 1;
  while (end < lines.length && !headings.includes(lower(lines[end]!))) end++;
  return lines.slice(start + 1, end);
}

type Experience = ResumeStructured['experience'][number];

function parseExperience(lines: readonly string[], variant: LinkedInVariant): Experience[] {
  const dates = lines.flatMap((l, i) => (DATE_RANGE.test(l) ? [i] : []));
  const roles: Experience[] = [];
  let organization: string | null = null;
  dates.forEach((d, k) => {
    const range = parseRange(lines[d]!)!;
    let title: string;
    if (variant === 'PASTED') {
      // Web order: Title, "Company · Full-time", dates. Grouped roles omit the company line.
      const above = lines[d - 1] ?? '';
      const company = /·/.test(above) ? above.split('·')[0]!.trim() : null;
      if (company !== null && d - 2 >= 0) {
        organization = company;
        title = lines[d - 2]!;
      } else {
        title = above;
      }
    } else {
      // PDF order: Company, [total tenure], Title, dates. Grouped roles repeat Title, dates.
      title = lines[d - 1] ?? '';
      const before = lines[d - 2];
      const prevEnd = k === 0 ? -1 : dates[k - 1]!;
      if (before !== undefined && d - 2 > prevEnd) {
        if (DURATION_ONLY.test(before) && d - 3 > prevEnd) organization = lines[d - 3]!;
        else if (k === 0 || (looksLikeName(before) && !looksLikeLocation(before)))
          organization = before;
      }
    }
    // The description runs to the next role's heading lines.
    let from = d + 1;
    if (lines[from] && looksLikeLocation(lines[from]!)) from++;
    const next = dates[k + 1];
    let to = next === undefined ? lines.length : next - 1;
    if (next !== undefined) {
      if (variant === 'PASTED') to = /·/.test(lines[next - 1] ?? '') ? next - 2 : next - 1;
      else {
        const b = lines[next - 2];
        if (b !== undefined && next - 2 >= from) {
          if (DURATION_ONLY.test(b)) to = next - 3;
          else if (looksLikeName(b) && !looksLikeLocation(b)) to = next - 2;
        }
      }
    }
    roles.push({
      title: title.slice(0, 120),
      organization: organization?.slice(0, 120) ?? null,
      start: range.start,
      end: range.end,
      current: range.current,
      highlights: highlights(lines.slice(from, Math.max(from, to))),
    });
  });
  return roles.slice(0, 20);
}

/** "(2016 - 2020)" at the end of a line; the end year is kept. */
const TRAILING_YEARS = /\(?\s*(?:[a-z]+\s+)?(?:\d{4})?\s*[-–—]\s*(?:[a-z]+\s+)?(\d{4})\s*\)?\s*$/i;
const YEARS_ONLY = /^\(?\s*(?:[a-z]+\s+)?\d{4}\s*[-–—]\s*(?:[a-z]+\s+)?(\d{4})\s*\)?$/i;

const endYear = (line: string) => {
  const year = Number(TRAILING_YEARS.exec(line)?.[1]);
  return year >= 1950 && year <= 2100 ? year : null;
};

function parseEducation(lines: readonly string[]): ResumeStructured['education'] {
  const out: ResumeStructured['education'] = [];
  const add = (qualification: string, institution: string | null, year: number | null) =>
    out.push({
      qualification: qualification.slice(0, 160),
      institution: institution?.slice(0, 160) ?? null,
      year,
    });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    const after = lines[i + 2];
    if (next && TRAILING_YEARS.test(next) && !YEARS_ONLY.test(next)) {
      // PDF export: the school, then "Degree, Field · (2016 - 2020)".
      const degree = next.replace(TRAILING_YEARS, '').replace(/[\s·•,]+$/, '');
      add(degree || line, degree ? line : null, endYear(next));
      i += 1;
    } else if (next && after && YEARS_ONLY.test(after) && looksLikeName(next)) {
      // Pasted profile: the school, the degree, then the years on their own line.
      add(next, line, endYear(after));
      i += 2;
    } else if (next && YEARS_ONLY.test(next)) {
      add(line, null, endYear(next));
      i += 1;
    } else if (looksLikeName(line)) {
      add(line, null, null);
    }
  }
  return out.slice(0, 10);
}

const SKILL_NOISE =
  /endorse|show all|^\d+ (?:experiences?|endorsements?)|passed linkedin|skill assessment/i;

export interface LinkedInProfile {
  variant: LinkedInVariant;
  structured: ResumeStructured;
  /** The Summary / About text (kept for the ATS "summary" check). */
  summary: string | null;
}

/**
 * Parses a LinkedIn profile (PDF export or pasted text). Returns null when
 * the text is not recognisably a LinkedIn profile.
 */
export function parseLinkedInProfile(text: string, now = new Date()): LinkedInProfile | null {
  const variant = detectLinkedInProfile(text);
  if (!variant) return null;
  const lines = cleanLines(text);
  const index = (heading: string) => lines.findIndex((l) => lower(l) === heading);
  const headings = variant === 'PDF_EXPORT' ? [...PDF_SIDEBAR, ...PDF_MAIN] : WEB_HEADINGS;

  const experienceAt = index('experience');
  const educationAt = index('education');
  const summaryAt = index(variant === 'PDF_EXPORT' ? 'summary' : 'about');
  const skillsAt = index(variant === 'PDF_EXPORT' ? 'top skills' : 'skills');
  const certsAt = index(variant === 'PDF_EXPORT' ? 'certifications' : 'licenses & certifications');

  // PDF: the main column opens with name, headline and location right before Summary/Experience.
  const mainAt = summaryAt >= 0 ? summaryAt : experienceAt;
  let headline: string | null = null;
  let mainStart = mainAt;
  if (variant === 'PDF_EXPORT' && mainAt >= 2) {
    const locationFirst = looksLikeLocation(lines[mainAt - 1]!);
    headline = locationFirst ? lines[mainAt - 2]! : lines[mainAt - 1]!;
    mainStart = mainAt - (locationFirst ? 3 : 2);
  }
  // Sidebar sections stop where the main column starts (the name is never read).
  const sidebar = (at: number) =>
    at < 0 ? [] : section(lines, at, headings).slice(0, Math.max(0, mainStart - at - 1));
  const inMain = (at: number) => (at < 0 ? [] : section(lines, at, headings));
  const list = (at: number) => (variant === 'PDF_EXPORT' ? sidebar(at) : inMain(at));

  const skills = list(skillsAt)
    .filter((l) => !SKILL_NOISE.test(l) && l.length <= 80)
    .map((name) => name.replace(BULLET, ''))
    .filter((name, i, all) => all.indexOf(name) === i)
    .slice(0, 60)
    .map((name) => ({ name, level: null, evidence: null }));
  const certifications = list(certsAt)
    .filter((l) => looksLikeName(l) && !/^(issued|credential)/i.test(l))
    .slice(0, 20)
    .map((c) => c.slice(0, 160));
  const experience = experienceAt >= 0 ? parseExperience(inMain(experienceAt), variant) : [];
  const education = educationAt >= 0 ? parseEducation(inMain(educationAt)) : [];
  const summary = summaryAt >= 0 ? inMain(summaryAt).join(' ').trim() || null : null;

  return {
    variant,
    summary,
    structured: {
      headline: headline?.slice(0, 200) ?? null,
      totalExperienceYears: experienceYears(experience, now),
      skills,
      experience,
      projects: [],
      education,
      certifications,
    },
  };
}
