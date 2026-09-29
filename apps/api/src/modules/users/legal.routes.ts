import type { ApiEnv } from '@cbi/config';
import type { LegalInfo } from '@cbi/shared-types';
import { Router } from 'express';

export function legalInfo(env: ApiEnv): LegalInfo {
  return {
    grievanceOfficer: {
      name: env.GRIEVANCE_OFFICER_NAME ?? null,
      email: env.GRIEVANCE_OFFICER_EMAIL ?? null,
      address: env.GRIEVANCE_OFFICER_ADDRESS ?? null,
    },
    draft: env.LEGAL_DRAFT_BANNER,
    lastUpdated: env.LEGAL_LAST_UPDATED ?? null,
    recordingRetentionDays: env.MEDIA_RETENTION_DAYS_DEFAULT,
    deletionGraceDays: env.ACCOUNT_DELETION_GRACE_DAYS,
  };
}

/** `GET /legal`: public details for the Terms, Privacy Notice and Grievance pages. */
export function legalRouter(env: ApiEnv): Router {
  const router = Router();
  const body = { data: legalInfo(env) };
  router.get('/', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(body);
  });
  return router;
}
