import { renderPrompt, untrusted } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import {
  JobTargetModel,
  ResumeModel,
  ResumeTailoringModel,
  type JobTargetRecord,
  type ResumeRecord,
} from '@cbi/db';
import { canonicalSkill, isKnownSkill, scoreResumeMatch } from '@cbi/scoring-core';
import {
  ResumeTailoringAi,
  type JdStructured,
  type ResumeStructured,
  type TailoringGuardNote,
  type TailoringSuggestions,
} from '@cbi/shared-types';
import {
  jdRevisionText,
  resumeRevisionText,
  withRevision,
} from '../processors/confirmed-profile.js';
import { knownNames, redactForAi } from '../processors/pii.js';

/**
 * Tailoring suggestions for one resume and job description (`resume.tailor`).
 * The model may only reword what the resume already says; a deterministic
 * guard then removes anything it could not have taken from the resume:
 * numbers that are not in the resume become placeholders, rewrites of text
 * the resume does not contain are dropped, and so are rewrites naming an
 * organisation the resume never mentions. Without AI a deterministic
 * fallback still lists missing keywords and a fact-only summary.
 */

export interface TailoringDeps {
  ai: Pick<AiRuntime, 'router' | 'prompts'>;
  logger: Logger;
  /** The candidate's names to mask (tests inject it; the default reads the profile). */
  knownNames?: (userId: string) => Promise<string[]>;
}

/** Text of each document sent to the prompt (cost control). */
export const TAILOR_INPUT_CHARS = 12_000;

/** Placeholders the PII masking leaves in text; never part of a suggestion. */
const PII_TOKENS = /\[(?:EMAIL|PHONE|PROFILE_URL|ADDRESS|NAME)\]/g;
/** A number with its unit: "40%", "2M", "1,200", "3.5x", "10 lakh". */
const NUMBER =
  /(?<![\w[])\d[\d,]*(?:\.\d+)?(?:\s?(?:%|x|k|m|mn|bn|million|billion|lakh|crore|cr)\b|%)?/gi;
const PLACEHOLDER = /\[[^\][]{1,40}\]/g;
/** "at Globex", "for Initech Corp", "joined Hooli": an organisation named in a rewrite. */
const ORGANISATION = /\b(at|for|joined|with)\s+((?:[A-Z][\w&.'-]*)(?:\s+(?:[A-Z][\w&.'-]*|&))*)/g;

const clean = (s: string) =>
  s
    .replace(PII_TOKENS, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
const words = (s: string) => s.toLowerCase().match(/[a-z0-9%+#.]+/g) ?? [];

/** The digits a number is made of ("1,200" → "1200"), for comparison with the resume. */
const core = (n: string) => (n.match(/\d[\d,]*(?:\.\d+)?/)?.[0] ?? '').replace(/,/g, '');

export interface GuardResult {
  text: string;
  replaced: number;
}

/** Replaces every number the resume does not contain with a placeholder. */
export function guardNumbers(text: string, source: string): GuardResult {
  const known = new Set((source.match(NUMBER) ?? []).map(core));
  let replaced = 0;
  const out = text.replace(NUMBER, (match) => {
    if (known.has(core(match))) return match;
    replaced++;
    return /%/.test(match) ? '[X%]' : '[X]';
  });
  return { text: out, replaced };
}

/**
 * Employers (or tools) named in `text` that the resume never mentions:
 * "at Globex", "joined Hooli", "with Kafka". A tool spelled differently from
 * the resume ("K8s" for "Kubernetes") is recognised through the skill aliases.
 */
export function unknownOrganisations(
  text: string,
  source: string,
  /**
   * The employers, schools and certifications the structured resume lists.
   * When given, "at/for/joined X" must name one of them: text in the resume
   * body is not enough, because an injected instruction could put a name there.
   */
  known: readonly string[] | null = null,
): string[] {
  const lower = source.toLowerCase();
  const knownLower = known?.map((k) => k.toLowerCase()) ?? null;
  const out: string[] = [];
  for (const m of text.matchAll(ORGANISATION)) {
    const name = m[2]!.replace(/[.,]+$/, '');
    const n = name.toLowerCase();
    if (/^(?:I|We|The|A|An|Our|My|This|These)$/.test(name)) continue;
    // Tools: fine when the resume has them under any spelling ("K8s" for "Kubernetes").
    if (isKnownSkill(name) && (lower.includes(n) || lower.includes(canonicalSkill(name)))) continue;
    const employerLike = m[1]!.toLowerCase() !== 'with';
    if (employerLike && knownLower) {
      if (knownLower.some((k) => k.includes(n) || n.includes(k))) continue;
    } else if (lower.includes(n)) continue;
    out.push(name);
  }
  return out;
}

/** Organisations the structured resume lists, for `unknownOrganisations`. */
export const resumeOrganisations = (resume: ResumeStructured | null): string[] | null =>
  resume
    ? [
        ...resume.experience.map((e) => e.organization ?? ''),
        ...resume.education.map((e) => e.institution ?? ''),
        ...resume.certifications,
      ].filter(Boolean)
    : null;

/** Whether most of the quoted original's words appear in the resume. */
export function grounded(original: string, source: string): boolean {
  const quoted = words(original).filter((w) => w.length > 2);
  if (quoted.length === 0) return false;
  const have = new Set(words(source));
  return quoted.filter((w) => have.has(w)).length / quoted.length >= 0.7;
}

export interface GuardInput {
  ai: ResumeTailoringAi;
  /** Exactly what the model saw of the resume (masked), plus the candidate's revision. */
  source: string;
  missing: { keyword: string; mustHave: boolean }[];
  fallbackSummary: string;
  /** Employers, schools and certifications from the structured resume (null: use the text). */
  organisations: readonly string[] | null;
}

/** Applies the no-fabrication rules to a model reply. Pure. */
export function guardTailoring({
  ai,
  source,
  missing,
  fallbackSummary,
  organisations,
}: GuardInput): TailoringSuggestions {
  const notes = new Map<TailoringGuardNote, number>();
  const note = (n: TailoringGuardNote, count = 1) => {
    if (count > 0) notes.set(n, (notes.get(n) ?? 0) + count);
  };

  const bullets: TailoringSuggestions['bullets'] = [];
  for (const b of ai.bullets) {
    const original = clean(b.original);
    if (!grounded(original, source)) {
      note('UNGROUNDED_BULLET');
      continue;
    }
    if (unknownOrganisations(b.rewritten, source, organisations).length > 0) {
      note('UNKNOWN_EMPLOYER');
      continue;
    }
    const numbers = guardNumbers(clean(b.rewritten), source);
    note('METRIC_REPLACED', numbers.replaced);
    bullets.push({
      original,
      rewritten: numbers.text,
      keywords: b.keywords.map(clean).filter(Boolean),
      placeholders: [...new Set(numbers.text.match(PLACEHOLDER) ?? [])],
    });
  }

  let summary = clean(ai.summary);
  if (unknownOrganisations(summary, source, organisations).length > 0) {
    note('UNKNOWN_EMPLOYER');
    summary = fallbackSummary;
  } else {
    const numbers = guardNumbers(summary, source);
    note('METRIC_REPLACED', numbers.replaced);
    summary = numbers.text || fallbackSummary;
  }

  // The deterministic gap list is authoritative; the model's guidance is kept where it agrees.
  const guidance = new Map(
    ai.missingKeywords.map((k) => [canonicalSkill(k.keyword), clean(k.guidance)] as const),
  );
  const missingKeywords = missing.map((m) => ({
    keyword: m.keyword,
    guidance: guidance.get(canonicalSkill(m.keyword)) ?? '',
    mustHave: m.mustHave,
  }));
  for (const k of ai.missingKeywords) {
    const key = canonicalSkill(k.keyword);
    if (missing.some((m) => canonicalSkill(m.keyword) === key)) continue;
    // Only keywords the resume really lacks: the model sometimes misses a synonym.
    if (source.toLowerCase().includes(key)) continue;
    missingKeywords.push({
      keyword: clean(k.keyword),
      guidance: clean(k.guidance),
      mustHave: false,
    });
  }

  return {
    summary,
    bullets,
    missingKeywords: missingKeywords.slice(0, 15),
    guardNotes: [...notes].map(([n, count]) => ({ note: n, count })),
    source: 'AI',
  };
}

/** A fact-only summary from the structured resume, used without AI or when a summary fails the guard. */
export function fallbackSummary(resume: ResumeStructured | null, matchedSkills: string[]): string {
  if (!resume) return '';
  const lead = resume.headline ?? resume.experience[0]?.title ?? null;
  const years =
    resume.totalExperienceYears !== null
      ? `${resume.totalExperienceYears} years of experience`
      : null;
  const skills = matchedSkills.slice(0, 5);
  const first = [lead, years].filter(Boolean).join(' with ');
  const parts = [
    first ? `${first}.` : '',
    skills.length ? `Hands-on with ${skills.join(', ')}.` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

const mustHaveNames = (jd: JdStructured | null) =>
  jd?.skills.filter((s) => s.importance === 'MUST').map((s) => s.name) ?? [];

export interface TailoringInputs {
  userId: string;
  resume: Pick<ResumeRecord, 'rawText' | 'structured' | 'edited' | 'layout' | 'userId'>;
  target: Pick<JobTargetRecord, 'rawText' | 'structured' | 'edited' | 'roleTitle'>;
}

export interface TailoringOutcome {
  suggestions: TailoringSuggestions;
  promptVersion: number | null;
  /** The model's reply before the guard (null without AI): the AI evaluation checks it. */
  raw: ResumeTailoringAi | null;
  /** The resume text the model saw (masked), which the guard grounds against. */
  source: string;
}

/** Builds suggestions for one resume and JD; never throws for AI trouble (falls back). */
export async function buildTailoring(
  deps: TailoringDeps,
  { userId, resume, target }: TailoringInputs,
): Promise<TailoringOutcome> {
  const resumeStructured = resume.edited ?? resume.structured;
  const jdStructured = target.edited ?? target.structured;
  // What is missing, and what matched, comes from the deterministic match score.
  const report = scoreResumeMatch(
    {
      text: resume.rawText ?? '',
      structured: resumeStructured,
      layout: resume.layout ?? null,
      edited: Boolean(resume.edited),
    },
    { text: target.rawText ?? '', structured: jdStructured, edited: Boolean(target.edited) },
  );
  const all = [
    ...report.skills.mustHave.map((m) => ({ ...m, mustHave: true })),
    ...report.skills.niceToHave.map((m) => ({ ...m, mustHave: false })),
  ];
  const missing = all
    .filter((m) => !m.matched)
    .map((m) => ({ keyword: m.skill, mustHave: m.mustHave }));
  const matched = all.filter((m) => m.matched).map((m) => m.skill);
  const factsOnly = fallbackSummary(resumeStructured, matched);

  const names = await (deps.knownNames ?? knownNames)(userId);
  const resumeForAi = redactForAi(
    deps.logger,
    withRevision(
      resume.edited ? resumeRevisionText(resume.edited) : null,
      resume.rawText ?? '',
      TAILOR_INPUT_CHARS,
    ),
    { what: 'resume.tailor', userId, names },
  );
  const jdForAi = redactForAi(
    deps.logger,
    withRevision(
      target.edited ? jdRevisionText(target.edited) : null,
      target.rawText ?? '',
      TAILOR_INPUT_CHARS,
    ),
    { what: 'resume.tailor.jd', userId, addresses: false },
  );

  const fallback = (): TailoringSuggestions => ({
    summary: factsOnly,
    bullets: [],
    missingKeywords: missing.map((m) => ({ ...m, guidance: '' })),
    guardNotes: [],
    source: 'FALLBACK',
  });

  const prompt = await deps.ai.prompts.getActive('resume.tailor');
  if (!prompt) {
    deps.logger.warn('no active resume.tailor prompt; using the fallback');
    return { suggestions: fallback(), promptVersion: null, raw: null, source: resumeForAi };
  }
  try {
    const result = await deps.ai.router.run<ResumeTailoringAi>(
      'resume.tailor',
      {
        messages: renderPrompt(prompt, {
          jobTitle: untrusted(jdStructured?.title ?? target.roleTitle ?? ''),
          mustHave: untrusted(mustHaveNames(jdStructured).join(', ')),
          jd: untrusted(jdForAi),
          resume: untrusted(resumeForAi),
        }),
        output: { name: 'resume_tailor', schema: ResumeTailoringAi },
      },
      { userId, prompt: { key: prompt.key, version: prompt.version } },
    );
    return {
      suggestions: guardTailoring({
        ai: result.data,
        source: resumeForAi,
        missing,
        fallbackSummary: factsOnly,
        organisations: resumeOrganisations(resumeStructured),
      }),
      promptVersion: prompt.version,
      raw: result.data,
      source: resumeForAi,
    };
  } catch (err) {
    deps.logger.warn({ err }, 'tailoring AI unavailable; using the fallback');
    return {
      suggestions: fallback(),
      promptVersion: prompt.version,
      raw: null,
      source: resumeForAi,
    };
  }
}

/** The `resume.tailor` job: fills one resumeTailorings record. Idempotent. */
export async function processResumeTailor(
  deps: TailoringDeps,
  tailoringId: string,
  finalAttempt: boolean,
): Promise<void> {
  const record = await ResumeTailoringModel.findOne({ _id: tailoringId, status: 'PENDING' }).lean();
  if (!record) return;
  const fail = (failureCode: 'INPUT_NOT_READY' | 'INTERNAL') =>
    ResumeTailoringModel.updateOne(
      { _id: record._id, status: 'PENDING' },
      { $set: { status: 'FAILED', failureCode, completedAt: new Date() } },
    );
  try {
    const [resume, target] = await Promise.all([
      ResumeModel.findOne({ _id: record.resumeId, userId: record.userId }).lean(),
      JobTargetModel.findOne({
        _id: record.jobTargetId,
        userId: record.userId,
        deletedAt: null,
      }).lean(),
    ]);
    if (
      !resume ||
      !target ||
      resume.extraction.status !== 'READY' ||
      target.extraction.status !== 'READY'
    ) {
      await fail('INPUT_NOT_READY');
      return;
    }
    const { suggestions, promptVersion } = await buildTailoring(deps, {
      userId: String(record.userId),
      resume: resume as ResumeRecord,
      target: target as JobTargetRecord,
    });
    await ResumeTailoringModel.updateOne(
      { _id: record._id, status: 'PENDING' },
      { $set: { status: 'READY', suggestions, promptVersion, completedAt: new Date() } },
    );
    deps.logger.info(
      { tailoringId, source: suggestions.source, bullets: suggestions.bullets.length },
      'tailoring suggestions ready',
    );
  } catch (err) {
    if (finalAttempt) await fail('INTERNAL');
    throw err;
  }
}
