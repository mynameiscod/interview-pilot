import type { Logger } from '@cbi/config';
import {
  AuditLogModel,
  dueErasures,
  eraseAccount,
  type ErasureResult,
  type ErasureStorage,
} from '@cbi/db';
import type { Types } from 'mongoose';

export interface AccountErasureDeps {
  storage: ErasureStorage;
  logger: Logger;
  now?: Date;
  /** Injected in unit tests; default: the database. */
  due?: (now: Date) => Promise<(Types.ObjectId | string)[]>;
  erase?: (userId: Types.ObjectId | string, now: Date) => Promise<ErasureResult | null>;
  audit?: (result: ErasureResult, now: Date) => Promise<void>;
}

async function auditErasure(result: ErasureResult, now: Date) {
  // The audit trail is kept (no personal data: ids and counts only).
  await AuditLogModel.create({
    at: now,
    actorType: 'SYSTEM',
    action: 'privacy.account_erased',
    resourceType: 'user',
    resourceId: result.userId,
    outcome: 'SUCCESS',
    details: { storageObjects: result.storageObjects, documents: result.documents },
  });
}

/**
 * Erases accounts whose deletion grace period has ended. One account's
 * failure (usually storage) is logged and retried on the next run; the rest
 * continue.
 */
export async function runAccountErasure(deps: AccountErasureDeps) {
  const now = deps.now ?? new Date();
  const due = deps.due ?? ((at: Date) => dueErasures(at));
  const erase = deps.erase ?? ((id, at) => eraseAccount(id, deps.storage, { now: at }));
  const audit = deps.audit ?? auditErasure;
  const counts = { erased: 0, errors: 0 };
  for (const userId of await due(now)) {
    try {
      const result = await erase(userId, now);
      if (!result) continue;
      await audit(result, now);
      counts.erased += 1;
    } catch (err) {
      counts.errors += 1;
      deps.logger.warn({ err, userId: String(userId) }, 'account erasure failed; will retry');
    }
  }
  if (counts.erased + counts.errors > 0) deps.logger.info(counts, 'account erasure');
  return counts;
}
