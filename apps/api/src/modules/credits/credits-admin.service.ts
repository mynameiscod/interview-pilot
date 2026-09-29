import { randomUUID } from 'node:crypto';
import {
  adjustCredits,
  CreditLedgerModel,
  getCreditBalance,
  InsufficientCreditsError,
  UserModel,
  type CreditLedgerRecord,
} from '@cbi/db';
import type {
  AdminCreditAccount,
  CreditAdjustmentBody,
  CreditLedgerEntry,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';

const LEDGER_ROWS = 20;

export const ledgerEntry = (r: CreditLedgerRecord): CreditLedgerEntry => ({
  id: String(r._id),
  type: r.type,
  amount: r.amount,
  refType: r.refType,
  refId: r.refId,
  reason: r.reason,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Admin view of a candidate's credits and manual adjustments
 * (`ADMIN_ADJUSTMENT` in the ledger). Every adjustment needs a reason and is
 * audited in the same transaction as the ledger write.
 */
export function createCreditsAdminService(deps: { audit: AuditService }) {
  async function findUser(user: string) {
    const byId = /^[0-9a-f]{24}$/i.test(user);
    const row = await UserModel.findOne(
      byId ? { _id: user } : { primaryEmail: user.toLowerCase() },
      { primaryEmail: 1 },
    ).lean();
    if (!row) throw AppError.notFound('No user with this email or id');
    return {
      userId: String(row._id),
      email: (row as { primaryEmail?: string | null }).primaryEmail ?? null,
    };
  }

  async function account(userId: string, email: string | null): Promise<AdminCreditAccount> {
    const [balance, ledger] = await Promise.all([
      getCreditBalance(userId),
      CreditLedgerModel.find({ userId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(LEDGER_ROWS)
        .lean<CreditLedgerRecord[]>(),
    ]);
    return { userId, userEmail: email, balance, ledger: ledger.map(ledgerEntry) };
  }

  return {
    /** A candidate's balance and latest ledger entries, by exact email or user id. */
    async lookup(user: string): Promise<AdminCreditAccount> {
      const found = await findUser(user.trim());
      return account(found.userId, found.email);
    },

    async adjust(
      body: CreditAdjustmentBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<AdminCreditAccount> {
      const found = await findUser(body.userId);
      const now = new Date();
      try {
        await transaction(async (session) => {
          await adjustCredits(
            {
              userId: found.userId,
              delta: body.delta,
              reason: body.reason,
              actorId,
              idempotencyKey: `admin-adjust:${randomUUID()}`,
              expiresAt:
                body.delta > 0 && body.expiresInDays
                  ? new Date(now.getTime() + body.expiresInDays * 86_400_000)
                  : null,
              now,
            },
            session,
          );
          await deps.audit.record(
            {
              actorType: 'ADMIN',
              actorId,
              action: body.delta > 0 ? 'credits.grant' : 'credits.deduct',
              resourceType: 'user',
              resourceId: found.userId,
              details: {
                delta: body.delta,
                expiresInDays: body.delta > 0 ? body.expiresInDays : null,
                reason: body.reason,
              },
            },
            ctx,
            session,
          );
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          throw new AppError(
            409,
            'INSUFFICIENT_CREDITS',
            'The candidate does not have that many usable credits (credits held by an interview in progress cannot be deducted).',
          );
        }
        throw err;
      }
      return account(found.userId, found.email);
    },
  };
}

export type CreditsAdminService = ReturnType<typeof createCreditsAdminService>;
