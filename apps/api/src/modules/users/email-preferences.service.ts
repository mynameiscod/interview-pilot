import { verifyEmailLink } from '@cbi/auth-core';
import { mongoose, UserModel, UserProfileModel } from '@cbi/db';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';

/**
 * One-click unsubscribe from product emails (practice nudges). The link in
 * each email carries a token signed by the worker (see @cbi/auth-core
 * email-links); following it needs no sign-in. The candidate page posts the
 * token, so link scanners that only GET cannot unsubscribe anyone.
 */
export function createEmailPreferencesService(deps: {
  linkKey: Buffer;
  audit: AuditService;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    async unsubscribe(token: string, ctx: ClientContext) {
      const claims = verifyEmailLink(deps.linkKey, token, 'unsubscribe', now());
      if (!claims || !mongoose.isValidObjectId(claims.userId)) {
        throw AppError.validation('This unsubscribe link is not valid. Change it in your profile.');
      }
      const user = await UserModel.exists({ _id: claims.userId, status: { $ne: 'DELETED' } });
      if (!user) {
        throw AppError.validation('This unsubscribe link is not valid. Change it in your profile.');
      }
      // Idempotent: a second click changes nothing but still confirms.
      const res = await UserProfileModel.updateOne(
        { userId: claims.userId, productUpdatesOptIn: true },
        { $set: { productUpdatesOptIn: false } },
      );
      if (res.modifiedCount === 1) {
        await deps.audit.record(
          {
            actorType: 'USER',
            actorId: claims.userId,
            action: 'profile.product_updates_unsubscribed',
            resourceType: 'user',
            resourceId: claims.userId,
            details: { via: 'email-link' },
          },
          ctx,
        );
      }
      return { unsubscribed: true as const };
    },
  };
}

export type EmailPreferencesService = ReturnType<typeof createEmailPreferencesService>;
