export type LegalDoc = 'terms' | 'privacy' | 'grievance' | 'scoring';

/** Public URL of each legal page (also used by footers and sign-in notices). */
export const LEGAL_PATHS: Record<LegalDoc, string> = {
  terms: '/terms',
  privacy: '/privacy-policy',
  grievance: '/grievance',
  scoring: '/how-scoring-works',
};
