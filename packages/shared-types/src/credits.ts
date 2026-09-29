import { z } from 'zod';

/**
 * Interview credits (Phase 4 core; purchases arrive in Phase 6). The ledger
 * is immutable and authoritative; balances are a projection updated in the
 * same transaction.
 */
export const CreditEntryType = z.enum([
  'FREE_GRANT',
  'PURCHASE',
  'INTERVIEW_RESERVE',
  'INTERVIEW_CONSUME',
  'INTERVIEW_REFUND',
  'ADMIN_ADJUSTMENT',
  'EXPIRY',
]);
export type CreditEntryType = z.infer<typeof CreditEntryType>;

export const CreditLotSource = z.enum(['FREE_GRANT', 'PURCHASE', 'ADMIN_ADJUSTMENT']);
export type CreditLotSource = z.infer<typeof CreditLotSource>;

/** Credits every verified account receives once. */
export const FREE_GRANT_CREDITS = 1;

export const CreditBalance = z.object({
  /** Credits that can start an interview now. */
  available: z.number().int(),
  /** Credits held by interviews in progress. */
  reserved: z.number().int(),
  lots: z.array(
    z.object({
      source: CreditLotSource,
      remaining: z.number().int(),
      expiresAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type CreditBalance = z.infer<typeof CreditBalance>;

export const CreditLedgerEntry = z.object({
  id: z.string(),
  type: CreditEntryType,
  amount: z.number().int(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntry>;

export const CreditLedgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CreditLedgerQuery = z.infer<typeof CreditLedgerQuery>;

// ---- Admin adjustments ----------------------------------------------------------------------

/** Find a candidate's credit account by exact email or user id. */
export const AdminCreditLookupQuery = z.object({ user: z.string().trim().min(3).max(254) });
export type AdminCreditLookupQuery = z.infer<typeof AdminCreditLookupQuery>;

export const AdminCreditAccount = z.object({
  userId: z.string(),
  userEmail: z.string().nullable(),
  balance: CreditBalance,
  /** The latest ledger entries, newest first. */
  ledger: z.array(CreditLedgerEntry),
});
export type AdminCreditAccount = z.infer<typeof AdminCreditAccount>;

/**
 * Grants (positive) or deducts (negative) credits by hand. A deduction takes
 * usable credits earliest-expiring first and fails when there are not enough.
 */
export const CreditAdjustmentBody = z.object({
  userId: z.string().regex(/^[0-9a-f]{24}$/i, 'invalid user id'),
  delta: z
    .number()
    .int()
    .min(-500)
    .max(500)
    .refine((d) => d !== 0, 'must not be zero'),
  reason: z.string().trim().min(3).max(300),
  /** Grants only: days until the granted credits expire; null = no expiry. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});
export type CreditAdjustmentBody = z.infer<typeof CreditAdjustmentBody>;
