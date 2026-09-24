import { z } from 'zod';

/**
 * Candidate inputs (Phase 3): resumes and job targets. Files are stored in
 * object storage, never in MongoDB; parsing runs in the worker.
 */

export const DOCUMENT_MIME = {
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  TXT: 'text/plain',
} as const;
export const DocumentMime = z.enum([DOCUMENT_MIME.PDF, DOCUMENT_MIME.DOCX, DOCUMENT_MIME.TXT]);
export type DocumentMime = z.infer<typeof DocumentMime>;

/** Hard caps that apply before and during parsing. */
export const DOCUMENT_LIMITS = {
  /** Stored raw text is capped (the design's ~200 KB). */
  maxTextChars: 200_000,
  maxPdfPages: 30,
  /** Total uncompressed size allowed inside a DOCX (zip-bomb guard). */
  maxDocxUncompressedBytes: 25 * 1024 * 1024,
  /** Below this much text a PDF is treated as scanned (image-only). */
  minTextChars: 200,
  maxPasteChars: 60_000,
  minPasteChars: 50,
} as const;

export const ExtractionStatus = z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']);
export type ExtractionStatus = z.infer<typeof ExtractionStatus>;

/** Why an input could not be used. Clients show a specific, actionable message per code. */
export const ExtractionErrorCode = z.enum([
  'UNSUPPORTED_TYPE',
  'TOO_LARGE',
  'CORRUPT',
  'ENCRYPTED',
  'NO_TEXT',
  'TOO_MANY_PAGES',
  'URL_BLOCKED',
  'FETCH_FAILED',
  'NOT_READABLE',
  'INTERNAL',
]);
export type ExtractionErrorCode = z.infer<typeof ExtractionErrorCode>;

export const ExtractionWarning = z.enum([
  /** Text was longer than the cap and was cut. */
  'TEXT_TRUNCATED',
  /** Little or no text layer; OCR would be needed for a better result. */
  'OCR_NEEDED',
  /** AI structuring failed or is unavailable; the raw text is still used. */
  'STRUCTURE_UNAVAILABLE',
]);
export type ExtractionWarning = z.infer<typeof ExtractionWarning>;

export const Extraction = z.object({
  status: ExtractionStatus,
  errorCode: ExtractionErrorCode.nullable(),
  warnings: z.array(ExtractionWarning),
  parser: z.string().nullable(),
  ocrUsed: z.boolean(),
  charCount: z.number().int(),
  completedAt: z.iso.datetime().nullable(),
});
export type Extraction = z.infer<typeof Extraction>;

const text = (max: number) => z.string().trim().max(max);
const yearMonth = z
  .string()
  .regex(/^\d{4}(-\d{2})?$/, 'YYYY or YYYY-MM')
  .nullable();

/**
 * Normalised resume. Deliberately excludes contact details (name, email,
 * phone, address): interviews and scoring never need them.
 */
export const ResumeStructured = z.object({
  headline: text(200).nullable(),
  totalExperienceYears: z.number().min(0).max(60).nullable(),
  skills: z
    .array(
      z.object({
        name: text(80),
        level: z.enum(['BASIC', 'WORKING', 'STRONG']).nullable(),
        evidence: text(300).nullable(),
      }),
    )
    .max(60),
  experience: z
    .array(
      z.object({
        title: text(120),
        organization: text(120).nullable(),
        start: yearMonth,
        end: yearMonth,
        current: z.boolean(),
        highlights: z.array(text(300)).max(8),
      }),
    )
    .max(20),
  projects: z
    .array(
      z.object({
        name: text(120),
        summary: text(400).nullable(),
        technologies: z.array(text(60)).max(15),
      }),
    )
    .max(15),
  education: z
    .array(
      z.object({
        qualification: text(160),
        institution: text(160).nullable(),
        year: z.number().int().min(1950).max(2100).nullable(),
      }),
    )
    .max(10),
  certifications: z.array(text(160)).max(20),
});
export type ResumeStructured = z.infer<typeof ResumeStructured>;

export const ResumeSummary = z.object({
  id: z.string(),
  originalName: z.string(),
  mime: DocumentMime,
  size: z.number().int(),
  extraction: Extraction,
  structured: ResumeStructured.nullable(),
  createdAt: z.iso.datetime(),
});
export type ResumeSummary = z.infer<typeof ResumeSummary>;

// ---- Job targets ------------------------------------------------------------------

export const JobTargetSource = z.enum(['PASTE', 'UPLOAD', 'URL', 'ROLE_ONLY']);
export type JobTargetSource = z.infer<typeof JobTargetSource>;

export const JdStructured = z.object({
  title: text(160),
  seniority: z.enum(['INTERN', 'JUNIOR', 'MID', 'SENIOR', 'LEAD']).nullable(),
  companyName: text(120).nullable(),
  location: text(120).nullable(),
  employmentType: text(60).nullable(),
  domain: text(120).nullable(),
  experienceYears: z
    .object({
      min: z.number().min(0).max(40).nullable(),
      max: z.number().min(0).max(40).nullable(),
    })
    .nullable(),
  responsibilities: z.array(text(300)).max(25),
  skills: z.array(z.object({ name: text(80), importance: z.enum(['MUST', 'NICE']) })).max(40),
  qualifications: z.array(text(300)).max(15),
});
export type JdStructured = z.infer<typeof JdStructured>;

/** http(s) only; the worker applies the full SSRF policy when fetching. */
export const JobUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine(
    // The authority part (between "://" and the first "/", "?" or "#") must not hold user:pass@.
    (u) => !/^[a-z]+:\/\/[^/?#]*@/i.test(u),
    'URLs with credentials are not allowed',
  );

const targetFields = {
  /** A company from the library, or a free-text name when it is not listed. */
  companyId: z.string().max(64).nullable().optional(),
  companyName: text(120).nullable().optional(),
  roleId: z.string().max(64).nullable().optional(),
  roleTitle: text(120).nullable().optional(),
};

export const CreateJobTargetBody = z
  .discriminatedUnion('source', [
    z.object({
      source: z.literal('PASTE'),
      text: z.string().trim().min(DOCUMENT_LIMITS.minPasteChars).max(DOCUMENT_LIMITS.maxPasteChars),
      ...targetFields,
    }),
    z.object({ source: z.literal('URL'), url: JobUrl, ...targetFields }),
    z.object({ source: z.literal('ROLE_ONLY'), ...targetFields }),
  ])
  .refine((b) => b.source !== 'ROLE_ONLY' || Boolean(b.roleId || b.roleTitle?.trim()), {
    message: 'Choose a role or type a role title',
    path: ['roleTitle'],
  });
export type CreateJobTargetBody = z.infer<typeof CreateJobTargetBody>;

/** Form fields sent alongside an uploaded JD file (multipart). */
export const UploadJobTargetFields = z.object({
  companyId: z.string().max(64).optional(),
  companyName: text(120).optional(),
  roleId: z.string().max(64).optional(),
  roleTitle: text(120).optional(),
});
export type UploadJobTargetFields = z.infer<typeof UploadJobTargetFields>;

export const JobTargetSummary = z.object({
  id: z.string(),
  source: JobTargetSource,
  url: z.string().nullable(),
  originalName: z.string().nullable(),
  extraction: Extraction,
  structured: JdStructured.nullable(),
  company: z.object({ id: z.string(), name: z.string() }).nullable(),
  companyName: z.string().nullable(),
  role: z.object({ id: z.string(), title: z.string() }).nullable(),
  roleTitle: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type JobTargetSummary = z.infer<typeof JobTargetSummary>;
