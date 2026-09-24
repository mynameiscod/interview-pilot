import { z } from 'zod';
import { ConfidenceLevel, ReadinessBand } from './evaluation.js';

/**
 * Candidate Proof (Phase 11, behind the `reports.publicProof` flag, off by
 * default): a candidate shares a read-only summary of one report by link.
 * The proof shows scores, never the transcript, evidence quotes, contact
 * details or recordings. Links expire, can be revoked, and only a hash of
 * the token is stored.
 */

export const CreateShareBody = z.object({
  expiresInDays: z.number().int().min(1).max(30).default(14),
});
export type CreateShareBody = z.infer<typeof CreateShareBody>;

export const ShareLinkSummary = z.object({
  id: z.string(),
  sessionId: z.string(),
  reportRevision: z.number().int(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  views: z.number().int(),
  lastViewedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  tokenHint: z.string(),
});
export type ShareLinkSummary = z.infer<typeof ShareLinkSummary>;

/** Returned once, at creation: `/proof/<token>` on the candidate site. */
export const CreatedShareLink = z.object({ link: ShareLinkSummary, path: z.string() });
export type CreatedShareLink = z.infer<typeof CreatedShareLink>;

/** The public proof page. */
export const ProofView = z.object({
  /** The candidate's display name, if they set one. */
  candidateName: z.string().nullable(),
  roleTitle: z.string(),
  mode: z.string(),
  completedAt: z.iso.datetime().nullable(),
  overall: z.number().int().nullable(),
  band: ReadinessBand,
  confidence: ConfidenceLevel,
  dimensions: z.array(
    z.object({ name: z.string(), score: z.number().int().nullable(), weight: z.number() }),
  ),
  /** The report revision shown (manual reviews create later ones). */
  reviewed: z.boolean(),
  expiresAt: z.iso.datetime(),
  disclaimer: z.string(),
});
export type ProofView = z.infer<typeof ProofView>;
