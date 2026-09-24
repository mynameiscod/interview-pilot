import { z } from 'zod';

/**
 * The interview library (Phase 3): companies, canonical roles, role
 * blueprints and interview templates. Blueprints and templates are
 * append-only by version; sessions reference the exact version they used.
 */

export const Seniority = z.enum(['INTERN', 'JUNIOR', 'MID', 'SENIOR', 'LEAD']);
export type Seniority = z.infer<typeof Seniority>;

export const RoleFamily = z.enum([
  'ENGINEERING',
  'DATA',
  'QUALITY',
  'INFRASTRUCTURE',
  'PRODUCT',
  'DESIGN',
  'BUSINESS',
  'OTHER',
]);
export type RoleFamily = z.infer<typeof RoleFamily>;

export const CompetencyCategory = z.enum([
  'TECHNICAL',
  'PROBLEM_SOLVING',
  'COMMUNICATION',
  'BEHAVIORAL',
  'DOMAIN',
]);
export type CompetencyCategory = z.infer<typeof CompetencyCategory>;

export const RoundType = z.enum([
  'INTRO',
  'TECHNICAL',
  'PROBLEM_SOLVING',
  'BEHAVIORAL',
  'CODING',
  'WRAP_UP',
]);
export type RoundType = z.infer<typeof RoundType>;

export const Difficulty = z.enum(['EASY', 'MEDIUM', 'HARD']);
export type Difficulty = z.infer<typeof Difficulty>;

export const EvidenceSource = z.enum(['ROLE', 'JD', 'RESUME', 'COMPANY']);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

export const LibraryStatus = z.enum(['DRAFT', 'ACTIVE', 'RETIRED']);
export type LibraryStatus = z.infer<typeof LibraryStatus>;

const text = (max: number) => z.string().trim().max(max);
const slugKey = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case words separated by hyphens');

// ---- Role blueprint -----------------------------------------------------------------

/**
 * What an interview for a role must assess. The interview engine (Phase 4)
 * plans questions from `competencies`; scoring (Phase 5) weights dimensions
 * by `weight`. `schemaVersion` changes only with a migration.
 */
const Competency = z.object({
  key: slugKey,
  name: text(80).min(2),
  category: CompetencyCategory,
  /** Relative importance; all weights sum to 100. */
  weight: z.number().int().min(1).max(100),
  description: text(400),
  subCompetencies: z.array(text(80)).max(8),
  /** What a strong answer demonstrates; drives follow-ups and evidence extraction. */
  expectedEvidence: z.array(text(200)).min(1).max(8),
  difficulty: Difficulty,
  roundTypes: z.array(RoundType).min(1),
});

const BlueprintContentObject = z.object({
  schemaVersion: z.literal(1),
  role: z.object({
    title: text(120).min(2),
    family: RoleFamily,
    seniority: Seniority,
    summary: text(600),
  }),
  competencies: z.array(Competency).min(3).max(12),
  focusSkills: z
    .array(
      z.object({
        name: text(80),
        weight: z.number().int().min(1).max(100),
        source: EvidenceSource,
      }),
    )
    .max(20),
  /** Resume claims to verify or JD requirements the resume does not show. */
  probeAreas: z
    .array(z.object({ topic: text(160), reason: text(300), source: EvidenceSource }))
    .max(10),
  notes: text(1000).nullable(),
});

/**
 * Structured output requested from `blueprint.generate`. Models rarely get
 * slug keys and a weight total of exactly 100 right, so the draft relaxes
 * both; the worker normalises it and then validates it as BlueprintContent.
 */
export const BlueprintDraftAi = BlueprintContentObject.extend({
  competencies: z
    .array(Competency.extend({ key: text(80) }))
    .min(3)
    .max(12),
});
export type BlueprintDraftAi = z.infer<typeof BlueprintDraftAi>;

export const BlueprintContent = BlueprintContentObject.superRefine((c, ctx) => {
  const total = c.competencies.reduce((sum, x) => sum + x.weight, 0);
  if (total !== 100) {
    ctx.addIssue({
      code: 'custom',
      path: ['competencies'],
      message: `weights must sum to 100 (got ${total})`,
    });
  }
  const keys = c.competencies.map((x) => x.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['competencies'],
      message: 'competency keys must be unique',
    });
  }
});
export type BlueprintContent = z.infer<typeof BlueprintContent>;

export const BlueprintOrigin = z.enum(['CANONICAL', 'AI_GENERATED']);
export type BlueprintOrigin = z.infer<typeof BlueprintOrigin>;

export const BlueprintSummary = z.object({
  id: z.string(),
  roleId: z.string().nullable(),
  origin: BlueprintOrigin,
  version: z.number().int(),
  status: LibraryStatus,
  content: BlueprintContent,
  contentHash: z.string(),
  generatedBy: z
    .object({ model: z.string(), promptVersion: z.number().int().nullable() })
    .nullable(),
  sourceJobTargetId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
});
export type BlueprintSummary = z.infer<typeof BlueprintSummary>;

export const CreateBlueprintVersionBody = z.object({
  content: BlueprintContent,
  reason: text(300).min(3),
});
export type CreateBlueprintVersionBody = z.infer<typeof CreateBlueprintVersionBody>;

/** Copies an AI-generated blueprint into a role's canonical history as a new DRAFT. */
export const PromoteBlueprintBody = z.object({
  roleId: z.string().min(1).max(64),
  reason: text(300).min(3),
});
export type PromoteBlueprintBody = z.infer<typeof PromoteBlueprintBody>;

export const LibraryReasonBody = z.object({ reason: text(300).min(3) });
export type LibraryReasonBody = z.infer<typeof LibraryReasonBody>;

// ---- Roles -------------------------------------------------------------------------

export const RoleSummary = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  family: RoleFamily,
  defaultSeniority: Seniority,
  aliases: z.array(z.string()),
  activeBlueprintId: z.string().nullable(),
  active: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type RoleSummary = z.infer<typeof RoleSummary>;

export const UpsertRoleBody = z.object({
  title: text(120).min(2),
  slug: slugKey,
  family: RoleFamily,
  defaultSeniority: Seniority,
  aliases: z.array(text(120).min(2)).max(20).default([]),
  active: z.boolean().default(true),
});
export type UpsertRoleBody = z.infer<typeof UpsertRoleBody>;

// ---- Companies ---------------------------------------------------------------------

export const PatternSourceType = z.enum([
  'PUBLIC_POSTING',
  'COMPANY_PUBLISHED',
  'EMPLOYER_PROVIDED',
  'OTHER',
]);
export type PatternSourceType = z.infer<typeof PatternSourceType>;

/**
 * An admin-verified note about how a company interviews. Only verified
 * notes influence interviews, and each keeps its source and verifier.
 */
export const VerifiedPattern = z.object({
  note: text(500).min(5),
  sourceType: PatternSourceType,
  sourceUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullable(),
  verifiedBy: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
});
export type VerifiedPattern = z.infer<typeof VerifiedPattern>;

export const CompanySummary = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  website: z.string().nullable(),
  roleFamilies: z.array(RoleFamily),
  verifiedPatterns: z.array(VerifiedPattern),
  allowedQuestionCategories: z.array(CompetencyCategory),
  active: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type CompanySummary = z.infer<typeof CompanySummary>;

export const UpsertCompanyBody = z.object({
  name: text(120).min(2),
  slug: slugKey,
  description: text(1000).nullable().default(null),
  website: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullable()
    .default(null),
  roleFamilies: z.array(RoleFamily).default([]),
  verifiedPatterns: z
    .array(VerifiedPattern.pick({ note: true, sourceType: true, sourceUrl: true }))
    .max(30)
    .default([]),
  allowedQuestionCategories: z.array(CompetencyCategory).default(CompetencyCategory.options),
  active: z.boolean().default(true),
});
export type UpsertCompanyBody = z.infer<typeof UpsertCompanyBody>;

/** What candidates see when searching: no internal notes. */
export const LibrarySearchItem = z.object({ id: z.string(), name: z.string(), slug: z.string() });
export type LibrarySearchItem = z.infer<typeof LibrarySearchItem>;

export const LibrarySearchQuery = z.object({
  q: z.string().trim().max(80).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type LibrarySearchQuery = z.infer<typeof LibrarySearchQuery>;

// ---- Interview templates -------------------------------------------------------------

export const InterviewMode = z.enum(['TEXT', 'VOICE', 'VIDEO']);
export type InterviewMode = z.infer<typeof InterviewMode>;

/** Modes the platform can run today. */
export const AVAILABLE_INTERVIEW_MODES: readonly InterviewMode[] = ['TEXT', 'VOICE', 'VIDEO'];

export const TemplateRound = z.object({
  type: RoundType,
  durationSec: z.number().int().min(60).max(3600),
  questionCount: z.number().int().min(1).max(20),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD', 'ADAPTIVE']),
  followUpDepth: z.number().int().min(0).max(3),
  /** Evidence items required before the round may end early. */
  minEvidence: z.number().int().min(0).max(10),
});
export type TemplateRound = z.infer<typeof TemplateRound>;

export const TemplateContent = z
  .object({
    name: text(120).min(2),
    description: text(600),
    modes: z.array(InterviewMode).min(1),
    rounds: z.array(TemplateRound).min(1).max(8),
    codingRequired: z.boolean(),
    creditCost: z.number().int().min(0).max(10),
    proctoringPolicy: z.object({
      recording: z.enum(['OFF', 'OPTIONAL', 'REQUIRED']),
      tabSwitchTracking: z.boolean(),
    }),
    scoringPolicy: z.object({
      /** Category weights (percent). Must sum to 100. */
      dimensionWeights: z.record(CompetencyCategory, z.number().int().min(0).max(100)),
    }),
    reportPolicy: z.object({ showDimensionScores: z.boolean(), showTranscript: z.boolean() }),
  })
  .superRefine((t, ctx) => {
    const total = Object.values(t.scoringPolicy.dimensionWeights).reduce((a, b) => a + (b ?? 0), 0);
    if (total !== 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoringPolicy', 'dimensionWeights'],
        message: `must sum to 100 (got ${total})`,
      });
    }
    if (t.codingRequired && !t.rounds.some((r) => r.type === 'CODING')) {
      ctx.addIssue({
        code: 'custom',
        path: ['rounds'],
        message: 'a coding round is required when codingRequired is set',
      });
    }
  });
export type TemplateContent = z.infer<typeof TemplateContent>;

export const templateDurationSec = (content: Pick<TemplateContent, 'rounds'>) =>
  content.rounds.reduce((sum, r) => sum + r.durationSec, 0);

export const TemplateSummary = z.object({
  id: z.string(),
  key: z.string(),
  version: z.number().int(),
  status: LibraryStatus,
  content: TemplateContent,
  totalDurationSec: z.number().int(),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

export const CreateTemplateVersionBody = z.object({
  key: slugKey,
  content: TemplateContent,
  reason: text(300).min(3),
});
export type CreateTemplateVersionBody = z.infer<typeof CreateTemplateVersionBody>;

export const BlueprintListQuery = z.object({
  origin: BlueprintOrigin.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type BlueprintListQuery = z.infer<typeof BlueprintListQuery>;
