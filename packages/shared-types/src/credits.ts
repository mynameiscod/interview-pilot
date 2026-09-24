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
