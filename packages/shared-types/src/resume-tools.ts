import { z } from 'zod';

/**
 * Resume tools: a deterministic, explainable resume ↔ job description match
 * score (free, no AI) and AI tailoring suggestions that only reuse facts from
 * the resume. Both use the candidate's edited revisions when they exist.
 */

export const ResumeToolsBody = z.object({
  resumeId: z.string().min(1).max(64),
  jobTargetId: z.string().min(1).max(64),
});
export type ResumeToolsBody = z.infer<typeof ResumeToolsBody>;

// ---- Match score ------------------------------------------------------------------

export const MatchBand = z.enum(['STRONG', 'GOOD', 'FAIR', 'WEAK']);
export type MatchBand = z.infer<typeof MatchBand>;

export const MatchComponentKey = z.enum(['SKILLS', 'EXPERIENCE', 'SECTIONS', 'FORMATTING']);
export type MatchComponentKey = z.infer<typeof MatchComponentKey>;

export const SkillMatch = z.object({
  /** The skill as the job description names it. */
  skill: z.string(),
  matched: z.boolean(),
  /** How the resume says it when that differs (a synonym such as "k8s" for Kubernetes). */
  matchedAs: z.string().nullable(),
  /** Where it was found: the skills list/projects, or elsewhere in the resume text. */
  foundIn: z.enum(['SKILLS', 'TEXT']).nullable(),
});
export type SkillMatch = z.infer<typeof SkillMatch>;

export const ExperienceFit = z.enum(['MEETS', 'BELOW', 'ABOVE', 'UNKNOWN']);
export type ExperienceFit = z.infer<typeof ExperienceFit>;

export const ResumeSectionKey = z.enum([
  'CONTACT',
  'SUMMARY',
  'SKILLS',
  'EXPERIENCE_DATES',
  'EDUCATION',
]);
export type ResumeSectionKey = z.infer<typeof ResumeSectionKey>;

export const FormattingRiskKey = z.enum([
  'TABLES',
  'COLUMNS',
  'IMAGE_ONLY',
  'TOO_LONG',
  'TOO_SHORT',
]);
export type FormattingRiskKey = z.infer<typeof FormattingRiskKey>;

/**
 * Stable reason codes. Clients show a localized sentence per code, filling
 * in `params`; `points` is what the reason added or cost.
 */
export const MatchReasonCode = z.enum([
  'MUST_HAVE_MATCHED',
  'MUST_HAVE_MISSING',
  'NICE_TO_HAVE_MATCHED',
  'NICE_TO_HAVE_MISSING',
  'SYNONYM_MATCHED',
  'NO_JD_SKILLS',
  'EXPERIENCE_MEETS',
  'EXPERIENCE_BELOW',
  'EXPERIENCE_ABOVE',
  'EXPERIENCE_UNKNOWN',
  'SECTION_PRESENT',
  'SECTION_MISSING',
  'FORMAT_RISK',
  'LAYOUT_UNKNOWN',
]);
export type MatchReasonCode = z.infer<typeof MatchReasonCode>;

export const MatchReason = z.object({
  code: MatchReasonCode,
  component: MatchComponentKey,
  impact: z.enum(['POSITIVE', 'NEGATIVE', 'INFO']),
  /** Points out of the component's maximum (negative for deductions). */
  points: z.number(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type MatchReason = z.infer<typeof MatchReason>;

export const ResumeMatchReport = z.object({
  /** 0-100, rounded. */
  score: z.number().int().min(0).max(100),
  band: MatchBand,
  /** Components that applied (SKILLS is left out when the JD lists no recognisable skills). */
  components: z.array(
    z.object({ key: MatchComponentKey, score: z.number(), max: z.number().positive() }),
  ),
  skills: z.object({ mustHave: z.array(SkillMatch), niceToHave: z.array(SkillMatch) }),
  experience: z.object({
    requiredMinYears: z.number().nullable(),
    requiredMaxYears: z.number().nullable(),
    candidateYears: z.number().nullable(),
    seniority: z.enum(['INTERN', 'JUNIOR', 'MID', 'SENIOR', 'LEAD']).nullable(),
    fit: ExperienceFit,
  }),
  sections: z.array(z.object({ key: ResumeSectionKey, present: z.boolean() })),
  formatting: z.array(z.object({ key: FormattingRiskKey, flagged: z.boolean() })),
  reasons: z.array(MatchReason),
  /** Whether the candidate's edited revisions were used. */
  usedEdits: z.object({ resume: z.boolean(), jd: z.boolean() }),
  computedAt: z.iso.datetime(),
});
export type ResumeMatchReport = z.infer<typeof ResumeMatchReport>;

// ---- Tailoring -----------------------------------------------------------------------

const line = (max: number) => z.string().trim().max(max);

/** What the `resume.tailor` prompt returns (schema-validated, then guarded). */
export const ResumeTailoringAi = z.object({
  summary: line(900),
  bullets: z
    .array(
      z.object({
        original: line(400),
        rewritten: line(400),
        keywords: z.array(line(60)).max(6),
      }),
    )
    .max(8),
  missingKeywords: z.array(z.object({ keyword: line(80), guidance: line(300) })).max(12),
});
export type ResumeTailoringAi = z.infer<typeof ResumeTailoringAi>;

export const TailoringStatus = z.enum(['PENDING', 'READY', 'FAILED']);
export type TailoringStatus = z.infer<typeof TailoringStatus>;

/** Why a suggestion was changed or dropped by the guard (shown to the candidate). */
export const TailoringGuardNote = z.enum([
  /** A number not in the resume was replaced with a placeholder. */
  'METRIC_REPLACED',
  /** A rewrite quoted text that is not in the resume; it was dropped. */
  'UNGROUNDED_BULLET',
  /** A rewrite named an organisation not in the resume; it was dropped. */
  'UNKNOWN_EMPLOYER',
]);
export type TailoringGuardNote = z.infer<typeof TailoringGuardNote>;

export const TailoringSuggestions = z.object({
  summary: z.string(),
  bullets: z.array(
    z.object({
      original: z.string(),
      rewritten: z.string(),
      keywords: z.array(z.string()),
      /** Placeholders such as [X%] the candidate must fill in or delete. */
      placeholders: z.array(z.string()),
    }),
  ),
  missingKeywords: z.array(
    z.object({
      keyword: z.string(),
      guidance: z.string(),
      mustHave: z.boolean(),
    }),
  ),
  guardNotes: z.array(z.object({ note: TailoringGuardNote, count: z.number().int() })),
  /** AI: from the model (after the guard). FALLBACK: built without AI when it was unavailable. */
  source: z.enum(['AI', 'FALLBACK']),
});
export type TailoringSuggestions = z.infer<typeof TailoringSuggestions>;

export const ResumeTailoringSummary = z.object({
  id: z.string(),
  resumeId: z.string(),
  jobTargetId: z.string(),
  status: TailoringStatus,
  suggestions: TailoringSuggestions.nullable(),
  failureCode: z.enum(['INPUT_NOT_READY', 'INTERNAL']).nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type ResumeTailoringSummary = z.infer<typeof ResumeTailoringSummary>;
