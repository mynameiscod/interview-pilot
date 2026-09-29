import type {
  DocumentLayout,
  ExperienceFit,
  FormattingRiskKey,
  JdStructured,
  MatchBand,
  MatchComponentKey,
  MatchReason,
  ResumeMatchReport,
  ResumeSectionKey,
  ResumeStructured,
  SkillMatch,
} from '@cbi/shared-types';

/**
 * Deterministic resume ↔ job description match score, in the spirit of an
 * applicant tracking system's keyword screen, with every point explained.
 * Pure: the same inputs always give the same score and reasons. No AI.
 *
 *   SKILLS      50  JD skills found in the resume; must-haves count 3×, nice-to-haves 1×.
 *                   Synonyms and aliases ("k8s", "Postgres", "JS") count as matches.
 *   EXPERIENCE  20  Years of experience against the JD's years or seniority.
 *   SECTIONS    15  Contact details, summary, skills, dated experience, education (3 each).
 *   FORMATTING  15  Deductions for suspected tables/columns, image-only files, length.
 *
 * A component with nothing to judge (a JD without recognisable skills) is
 * left out and the rest are scaled to 100.
 */

export const ATS_WEIGHTS: Readonly<Record<MatchComponentKey, number>> = {
  SKILLS: 50,
  EXPERIENCE: 20,
  SECTIONS: 15,
  FORMATTING: 15,
};
const MUST_WEIGHT = 3;
const NICE_WEIGHT = 1;
const FORMAT_PENALTY: Readonly<Record<FormattingRiskKey, number>> = {
  IMAGE_ONLY: 7,
  TABLES: 4,
  COLUMNS: 4,
  TOO_LONG: 3,
  TOO_SHORT: 3,
};
/** Beyond this many pages or words a resume is "very long" for a screen. */
const LONG_PAGES = 3;
const LONG_WORDS = 1500;
const SHORT_WORDS = 150;

// ---- Skill aliases --------------------------------------------------------------------

interface Alias {
  /** Every name for the skill; the first is the canonical one. */
  names: string[];
  /**
   * Names too ambiguous to search for in free text ("go", "rest", "ai"):
   * they only match a skills-list entry exactly.
   */
  listOnly?: string[];
}

/** Common technology skills and their usual spellings in Indian job posts and resumes. */
const ALIASES: Alias[] = [
  { names: ['javascript', 'ecmascript', 'es6'], listOnly: ['js'] },
  { names: ['typescript'], listOnly: ['ts'] },
  { names: ['node.js', 'nodejs', 'node js'], listOnly: ['node'] },
  { names: ['react', 'react.js', 'reactjs'] },
  { names: ['react native', 'react-native'] },
  { names: ['next.js', 'nextjs'] },
  { names: ['vue', 'vue.js', 'vuejs'] },
  { names: ['angular', 'angularjs', 'angular.js'] },
  { names: ['express.js', 'expressjs'], listOnly: ['express'] },
  { names: ['postgresql', 'postgres'], listOnly: ['psql', 'pg'] },
  { names: ['mysql'] },
  { names: ['sql server', 'mssql', 'ms sql', 'microsoft sql server'] },
  { names: ['mongodb', 'mongo'] },
  { names: ['redis'] },
  { names: ['elasticsearch', 'elastic search'] },
  { names: ['kafka', 'apache kafka'] },
  { names: ['rabbitmq'] },
  { names: ['kubernetes', 'k8s'] },
  { names: ['docker'] },
  { names: ['terraform'] },
  { names: ['aws', 'amazon web services'] },
  { names: ['gcp', 'google cloud', 'google cloud platform'] },
  { names: ['azure', 'microsoft azure'] },
  { names: ['ci/cd', 'cicd', 'ci cd', 'continuous integration', 'continuous delivery'] },
  { names: ['jenkins'] },
  { names: ['github actions'] },
  { names: ['git'] },
  { names: ['linux'] },
  { names: ['python'] },
  { names: ['java'] },
  { names: ['c#', 'csharp', 'c sharp'] },
  { names: ['c++', 'cpp'] },
  { names: ['golang'], listOnly: ['go'] },
  { names: ['rust'] },
  { names: ['kotlin'] },
  { names: ['swift'] },
  { names: ['php'] },
  { names: ['ruby on rails'], listOnly: ['rails'] },
  { names: ['.net', 'dotnet', 'asp.net', '.net core'] },
  { names: ['spring boot', 'springboot'], listOnly: ['spring'] },
  { names: ['django'] },
  { names: ['flask'] },
  { names: ['fastapi'] },
  { names: ['rest api', 'rest apis', 'restful', 'restful api', 'restful apis', 'restful services'], listOnly: ['rest'] },
  { names: ['graphql'] },
  { names: ['grpc'] },
  { names: ['microservices', 'microservice', 'micro services', 'micro-services'] },
  { names: ['system design'] },
  { names: ['data structures', 'data structures and algorithms'], listOnly: ['dsa'] },
  { names: ['object-oriented programming', 'object oriented programming'], listOnly: ['oop', 'oops'] },
  { names: ['html', 'html5'] },
  { names: ['css', 'css3'] },
  { names: ['tailwind', 'tailwind css', 'tailwindcss'] },
  { names: ['sass', 'scss'] },
  { names: ['redux'] },
  { names: ['jest'] },
  { names: ['cypress'] },
  { names: ['playwright'] },
  { names: ['selenium'] },
  { names: ['junit'] },
  { names: ['machine learning'], listOnly: ['ml'] },
  { names: ['deep learning'], listOnly: ['dl'] },
  { names: ['artificial intelligence'], listOnly: ['ai'] },
  { names: ['natural language processing'], listOnly: ['nlp'] },
  { names: ['large language models', 'llm', 'llms'] },
  { names: ['tensorflow'] },
  { names: ['pytorch'] },
  { names: ['scikit-learn', 'sklearn', 'scikit learn'] },
  { names: ['pandas'] },
  { names: ['numpy'] },
  { names: ['power bi', 'powerbi'] },
  { names: ['tableau'] },
  { names: ['ms excel', 'microsoft excel', 'advanced excel'], listOnly: ['excel'] },
  { names: ['sql'] },
  { names: ['statistics'] },
  { names: ['agile', 'scrum'] },
  { names: ['jira'] },
  { names: ['figma'] },
  { names: ['android'] },
  { names: ['ios'] },
  { names: ['flutter'] },
];

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

const BY_NAME = new Map<string, Alias>();
for (const alias of ALIASES) {
  for (const name of [...alias.names, ...(alias.listOnly ?? [])]) BY_NAME.set(name, alias);
}

/** Canonical key for a skill name (its alias group's first name, or the normalised name). */
export function canonicalSkill(name: string): string {
  const n = normalise(name);
  return BY_NAME.get(n)?.names[0] ?? n;
}

/** Whether the name is one of the known technology skills (any spelling). */
export const isKnownSkill = (name: string) => BY_NAME.has(normalise(name));

/** Every spelling worth looking for in free text for this skill. */
function textForms(name: string): string[] {
  const n = normalise(name);
  const alias = BY_NAME.get(n);
  if (!alias) return n.length >= 2 ? [n] : [];
  const listOnly = new Set(alias.listOnly ?? []);
  // Longest first, so the report names the fullest spelling the resume uses.
  return alias.names.filter((f) => !listOnly.has(f)).sort((a, b) => b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word search that respects skills ending in "+", "#" or ".js". */
function findForm(text: string, form: string): boolean {
  const pattern = escapeRe(form).replace(/ /g, '[\\s-]+');
  return new RegExp(`(?<![a-z0-9+#.])${pattern}(?![a-z0-9+#])`, 'i').test(text);
}

interface SkillIndex {
  /** Canonical skill → how the resume names it, from its skills list and projects. */
  listed: Map<string, string>;
  text: string;
}

function skillIndex(resume: ResumeStructured | null, text: string): SkillIndex {
  const listed = new Map<string, string>();
  const names = [
    ...(resume?.skills.map((s) => s.name) ?? []),
    ...(resume?.projects.flatMap((p) => p.technologies) ?? []),
  ];
  for (const raw of names) {
    for (const part of raw.split(/\s*[/,|]\s*/)) {
      if (!part.trim()) continue;
      const key = canonicalSkill(part);
      if (!listed.has(key)) listed.set(key, part.trim());
    }
  }
  const structuredText = resume
    ? [
        resume.headline ?? '',
        ...resume.experience.flatMap((e) => [e.title, ...e.highlights]),
        ...resume.projects.map((p) => `${p.name} ${p.summary ?? ''}`),
        ...resume.certifications,
      ].join('\n')
    : '';
  return { listed, text: `${text}\n${structuredText}` };
}

export function matchSkill(skill: string, index: SkillIndex): SkillMatch {
  // "Node.js/Express" or "AWS, GCP" in a JD: any listed part counts.
  const parts = skill.split(/\s*[/,|]\s*|\s+or\s+/i).filter(Boolean);
  for (const part of parts.length ? parts : [skill]) {
    const key = canonicalSkill(part);
    const listed = index.listed.get(key);
    if (listed) {
      const same = normalise(listed) === normalise(part);
      return { skill, matched: true, matchedAs: same ? null : listed, foundIn: 'SKILLS' };
    }
    for (const form of textForms(part)) {
      if (findForm(index.text, form)) {
        const same = normalise(form) === normalise(part);
        return { skill, matched: true, matchedAs: same ? null : form, foundIn: 'TEXT' };
      }
    }
  }
  return { skill, matched: false, matchedAs: null, foundIn: null };
}

/** Known skills mentioned in a job description, for JDs that could not be structured. */
export function skillsInText(text: string): string[] {
  const found: string[] = [];
  for (const alias of ALIASES) {
    const forms = alias.names.filter((f) => !(alias.listOnly ?? []).includes(f));
    if (forms.some((f) => findForm(text, f))) found.push(alias.names[0]!);
  }
  return found;
}

// ---- Experience ------------------------------------------------------------------------

type Seniority = NonNullable<JdStructured['seniority']>;

/** Typical years for a seniority when the JD gives none. */
const SENIORITY_YEARS: Readonly<Record<Seniority, { min: number; max: number | null }>> = {
  INTERN: { min: 0, max: 1 },
  JUNIOR: { min: 0, max: 2 },
  MID: { min: 2, max: 5 },
  SENIOR: { min: 5, max: null },
  LEAD: { min: 8, max: null },
};

/** "3+ years", "2-4 years", "minimum 5 yrs" in JD text. */
export function yearsInText(text: string): { min: number; max: number | null } | null {
  const range = /(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i.exec(text);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const min = /(?:minimum|min\.?|at least)?\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:experience|exp)/i.exec(
    text,
  );
  return min ? { min: Number(min[1]), max: null } : null;
}

function monthIndex(ym: string, end: boolean): number {
  const [y, m] = ym.split('-').map(Number);
  return y! * 12 + ((m ?? (end ? 12 : 1)) - 1);
}

/** Years from the dated roles (overlaps counted once), when the parse gave no total. */
export function candidateYears(resume: ResumeStructured | null, now: Date): number | null {
  if (!resume) return null;
  if (resume.totalExperienceYears !== null) return resume.totalExperienceYears;
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans = resume.experience
    .filter((e) => e.start)
    .map((e) => [monthIndex(e.start!, false), e.current || !e.end ? nowIndex : monthIndex(e.end, true)])
    .filter(([a, b]) => b! >= a!)
    .sort((a, b) => a[0]! - b[0]!);
  if (spans.length === 0) return null;
  let months = 0;
  let [start, end] = spans[0]! as [number, number];
  for (const [a, b] of spans.slice(1) as [number, number][]) {
    if (a <= end + 1) end = Math.max(end, b);
    else {
      months += end - start + 1;
      [start, end] = [a, b];
    }
  }
  months += end - start + 1;
  return Math.round((months / 12) * 10) / 10;
}

// ---- Sections ------------------------------------------------------------------------

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\d\s-]{8,}\d)/;
const SUMMARY_HEADING =
  /^(?:professional\s+|career\s+)?(?:summary|profile|objective|about(?: me)?|overview)\b/im;
const SKILLS_HEADING = /^(?:technical\s+|key\s+|core\s+|top\s+)?skills\b/im;
const EDUCATION_HEADING = /^(?:education|academics?|qualifications?)\b/im;
const DATE_RANGE = /\b(?:19|20)\d{2}\s*(?:-|–|to)\s*(?:(?:19|20)\d{2}|present|current|now)\b/i;

// ---- Scoring ---------------------------------------------------------------------------

export interface MatchResumeInput {
  /** Extracted resume text (searched, never returned). */
  text: string;
  /** The effective structured resume: the candidate's revision, else the parse. */
  structured: ResumeStructured | null;
  layout: DocumentLayout | null;
  edited: boolean;
}

export interface MatchJdInput {
  text: string;
  structured: JdStructured | null;
  edited: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function bandFor(score: number): MatchBand {
  if (score >= 80) return 'STRONG';
  if (score >= 65) return 'GOOD';
  if (score >= 45) return 'FAIR';
  return 'WEAK';
}

export function scoreResumeMatch(
  resume: MatchResumeInput,
  jd: MatchJdInput,
  now: Date = new Date(),
): ResumeMatchReport {
  const reasons: MatchReason[] = [];
  const components: ResumeMatchReport['components'] = [];
  const add = (r: MatchReason) => reasons.push(r);

  // -- Skills
  const index = skillIndex(resume.structured, resume.text);
  const jdSkills = jd.structured?.skills.length
    ? jd.structured.skills
    : skillsInText(jd.text).map((name) => ({ name, importance: 'MUST' as const }));
  const unique = (list: typeof jdSkills) =>
    list.filter((s, i) => list.findIndex((o) => canonicalSkill(o.name) === canonicalSkill(s.name)) === i);
  const must = unique(jdSkills.filter((s) => s.importance === 'MUST')).map((s) =>
    matchSkill(s.name, index),
  );
  const nice = unique(jdSkills.filter((s) => s.importance === 'NICE'))
    .filter((s) => !must.some((m) => canonicalSkill(m.skill) === canonicalSkill(s.name)))
    .map((s) => matchSkill(s.name, index));
  const totalWeight = must.length * MUST_WEIGHT + nice.length * NICE_WEIGHT;
  if (totalWeight > 0) {
    const unit = ATS_WEIGHTS.SKILLS / totalWeight;
    let skillsScore = 0;
    for (const [list, weight, hit, miss] of [
      [must, MUST_WEIGHT, 'MUST_HAVE_MATCHED', 'MUST_HAVE_MISSING'],
      [nice, NICE_WEIGHT, 'NICE_TO_HAVE_MATCHED', 'NICE_TO_HAVE_MISSING'],
    ] as const) {
      for (const m of list) {
        const points = m.matched ? round1(unit * weight) : 0;
        skillsScore += m.matched ? unit * weight : 0;
        add({
          code: m.matched ? hit : miss,
          component: 'SKILLS',
          impact: m.matched ? 'POSITIVE' : 'NEGATIVE',
          points,
          params: { skill: m.skill, ...(m.matched ? {} : { worth: round1(unit * weight) }) },
        });
        if (m.matchedAs) {
          add({
            code: 'SYNONYM_MATCHED',
            component: 'SKILLS',
            impact: 'INFO',
            points: 0,
            params: { skill: m.skill, as: m.matchedAs },
          });
        }
      }
    }
    components.push({ key: 'SKILLS', score: round1(skillsScore), max: ATS_WEIGHTS.SKILLS });
  } else {
    add({ code: 'NO_JD_SKILLS', component: 'SKILLS', impact: 'INFO', points: 0, params: {} });
  }

  // -- Experience and seniority
  const seniority = jd.structured?.seniority ?? null;
  const stated = jd.structured?.experienceYears;
  const fromText = yearsInText(jd.text);
  const required =
    stated && (stated.min !== null || stated.max !== null)
      ? { min: stated.min ?? 0, max: stated.max }
      : (fromText ?? (seniority ? SENIORITY_YEARS[seniority] : null));
  const years = candidateYears(resume.structured, now);
  let fit: ExperienceFit = 'UNKNOWN';
  let expScore = ATS_WEIGHTS.EXPERIENCE / 2;
  if (years === null || required === null) {
    add({
      code: 'EXPERIENCE_UNKNOWN',
      component: 'EXPERIENCE',
      impact: 'INFO',
      points: round1(expScore),
      params: { reason: years === null ? 'resume' : 'jd' },
    });
  } else if (years < required.min) {
    fit = 'BELOW';
    expScore = required.min > 0 ? ATS_WEIGHTS.EXPERIENCE * Math.max(0, years / required.min) : 0;
    add({
      code: 'EXPERIENCE_BELOW',
      component: 'EXPERIENCE',
      impact: 'NEGATIVE',
      points: round1(expScore),
      params: { years, required: required.min, gap: round1(required.min - years) },
    });
  } else if (required.max !== null && years > required.max + 3) {
    // Well above the band: still qualified, but screens often filter for level.
    fit = 'ABOVE';
    expScore = ATS_WEIGHTS.EXPERIENCE * 0.8;
    add({
      code: 'EXPERIENCE_ABOVE',
      component: 'EXPERIENCE',
      impact: 'INFO',
      points: round1(expScore),
      params: { years, max: required.max },
    });
  } else {
    fit = 'MEETS';
    expScore = ATS_WEIGHTS.EXPERIENCE;
    add({
      code: 'EXPERIENCE_MEETS',
      component: 'EXPERIENCE',
      impact: 'POSITIVE',
      points: expScore,
      params: { years, required: required.min },
    });
  }
  components.push({ key: 'EXPERIENCE', score: round1(expScore), max: ATS_WEIGHTS.EXPERIENCE });

  // -- Sections (contact details are only detected, never read out)
  const s = resume.structured;
  const text = resume.text;
  const present: Record<ResumeSectionKey, boolean> = {
    CONTACT: EMAIL.test(text) || PHONE.test(text),
    SUMMARY: SUMMARY_HEADING.test(text),
    SKILLS: (s?.skills.length ?? 0) >= 3 || SKILLS_HEADING.test(text),
    EXPERIENCE_DATES: s?.experience.length
      ? s.experience.every((e) => Boolean(e.start))
      : DATE_RANGE.test(text),
    EDUCATION: (s?.education.length ?? 0) > 0 || EDUCATION_HEADING.test(text),
  };
  const perSection = ATS_WEIGHTS.SECTIONS / 5;
  let sectionScore = 0;
  const sections = (Object.keys(present) as ResumeSectionKey[]).map((key) => {
    if (present[key]) sectionScore += perSection;
    add({
      code: present[key] ? 'SECTION_PRESENT' : 'SECTION_MISSING',
      component: 'SECTIONS',
      impact: present[key] ? 'POSITIVE' : 'NEGATIVE',
      points: present[key] ? perSection : 0,
      params: { section: key },
    });
    return { key, present: present[key] };
  });
  components.push({ key: 'SECTIONS', score: round1(sectionScore), max: ATS_WEIGHTS.SECTIONS });

  // -- Formatting risks
  const layout = resume.layout;
  const flags: Record<FormattingRiskKey, boolean> = {
    TABLES: layout?.tablesSuspected ?? false,
    COLUMNS: layout?.columnsSuspected ?? false,
    IMAGE_ONLY: layout?.imageOnly ?? false,
    TOO_LONG: layout ? (layout.pages ?? 0) > LONG_PAGES || layout.words > LONG_WORDS : false,
    TOO_SHORT: layout ? layout.words < SHORT_WORDS : false,
  };
  let formatScore = ATS_WEIGHTS.FORMATTING;
  if (!layout) {
    add({ code: 'LAYOUT_UNKNOWN', component: 'FORMATTING', impact: 'INFO', points: 0, params: {} });
  }
  const formatting = (Object.keys(flags) as FormattingRiskKey[]).map((key) => {
    if (flags[key]) {
      formatScore -= FORMAT_PENALTY[key];
      add({
        code: 'FORMAT_RISK',
        component: 'FORMATTING',
        impact: 'NEGATIVE',
        points: -FORMAT_PENALTY[key],
        params: {
          risk: key,
          ...(key === 'TOO_LONG' ? { pages: layout?.pages ?? 0, words: layout?.words ?? 0 } : {}),
        },
      });
    }
    return { key, flagged: flags[key] };
  });
  components.push({
    key: 'FORMATTING',
    score: Math.max(0, formatScore),
    max: ATS_WEIGHTS.FORMATTING,
  });

  const earned = components.reduce((sum, c) => sum + c.score, 0);
  const possible = components.reduce((sum, c) => sum + c.max, 0);
  const score = Math.max(0, Math.min(100, Math.round((earned / possible) * 100)));
  return {
    score,
    band: bandFor(score),
    components,
    skills: { mustHave: must, niceToHave: nice },
    experience: {
      requiredMinYears: required?.min ?? null,
      requiredMaxYears: required?.max ?? null,
      candidateYears: years,
      seniority,
      fit,
    },
    sections,
    formatting,
    reasons,
    usedEdits: { resume: resume.edited, jd: jd.edited },
    computedAt: now.toISOString(),
  };
}
