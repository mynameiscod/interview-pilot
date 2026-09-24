import { FREE_GRANT_CREDITS, type CreditBalance, type CreditLotSource } from '@cbi/shared-types';
import mongoose, { type ClientSession, type Types } from 'mongoose';
import {
  CreditAccountModel,
  CreditLedgerModel,
  type CreditAccountRecord,
  type CreditLedgerRecord,
  type CreditLotRecord,
} from './models/credits.js';

/**
 * Credit operations. Every change inserts one immutable ledger entry and
 * updates the account projection in the same transaction. Idempotency keys
 * make each business event happen at most once:
 *   free:<userId>      the one-time FREE grant
 *   reserve:<session>  the credit an interview holds
 *   settle:<session>   its consumption OR refund (never both)
 */

export class InsufficientCreditsError extends Error {
  constructor() {
    super('no credit available');
    this.name = 'InsufficientCreditsError';
  }
}

type Id = Types.ObjectId | string;
const oid = (id: Id) => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id);

/** Runs `fn` in the caller's transaction, or in a new one. */
export async function inTransaction<T>(
  session: ClientSession | undefined,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  if (session) return fn(session);
  const own = await mongoose.startSession();
  try {
    let result!: T;
    await own.withTransaction(async () => {
      result = await fn(own);
    });
    return result;
  } finally {
    await own.endSession();
  }
}

async function findEntry(key: string, session: ClientSession) {
  return CreditLedgerModel.findOne({ idempotencyKey: key }, null, { session }).lean();
}

async function loadAccount(userId: Id, session: ClientSession): Promise<CreditAccountRecord> {
  return (await CreditAccountModel.findOneAndUpdate(
    { userId: oid(userId) },
    // $inc on every load takes the document's write lock for this transaction.
    { $setOnInsert: { balance: 0, reserved: 0, lots: [] }, $inc: { version: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean())!;
}

const usable = (lot: CreditLotRecord, now: Date) =>
  lot.remaining > 0 && (lot.expiresAt === null || lot.expiresAt > now);

/** Earliest-expiring usable lot; lots without expiry come last. */
function pickLot(lots: readonly CreditLotRecord[], now: Date): CreditLotRecord | null {
  return (
    [...lots]
      .filter((l) => usable(l, now))
      .sort(
        (a, b) =>
          (a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY),
      )[0] ?? null
  );
}

export interface GrantInput {
  userId: Id;
  amount: number;
  source: CreditLotSource;
  idempotencyKey: string;
  expiresAt?: Date | null;
  refType?: string | null;
  refId?: string | null;
  actorId?: Id | null;
  reason?: string | null;
}

/** Adds a lot of credits. Returns false when the grant already happened. */
export async function grantCredits(input: GrantInput, session?: ClientSession): Promise<boolean> {
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new Error('grant must be positive');
  return inTransaction(session, async (s) => {
    if (await findEntry(input.idempotencyKey, s)) return false;
    await loadAccount(input.userId, s);
    const lotId = new mongoose.Types.ObjectId();
    const type =
      input.source === 'FREE_GRANT'
        ? 'FREE_GRANT'
        : input.source === 'PURCHASE'
          ? 'PURCHASE'
          : 'ADMIN_ADJUSTMENT';
    await CreditLedgerModel.create(
      [
        {
          userId: oid(input.userId),
          type,
          amount: input.amount,
          reservedDelta: 0,
          lotId,
          lotSource: input.source,
          expiresAt: input.expiresAt ?? null,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId ? oid(input.actorId) : null,
          reason: input.reason ?? null,
        },
      ],
      { session: s },
    );
    await CreditAccountModel.updateOne(
      { userId: oid(input.userId) },
      {
        $inc: { balance: input.amount, version: 1 },
        $push: {
          lots: {
            lotId,
            source: input.source,
            remaining: input.amount,
            expiresAt: input.expiresAt ?? null,
          },
        },
      },
      { session: s },
    );
    return true;
  });
}

/** The one-time FREE grant every verified account receives. Idempotent. */
export function grantFreeCredits(userId: Id, session?: ClientSession) {
  return grantCredits(
    {
      userId,
      amount: FREE_GRANT_CREDITS,
      source: 'FREE_GRANT',
      idempotencyKey: `free:${String(userId)}`,
      reason: 'Welcome credit',
    },
    session,
  );
}

/**
 * Holds one credit for an interview (earliest-expiring lot first).
 * Idempotent per session; throws InsufficientCreditsError when none is available.
 */
export async function reserveCredit(
  userId: Id,
  sessionId: Id,
  opts: { session?: ClientSession; now?: Date } = {},
): Promise<{ lotId: Types.ObjectId; created: boolean }> {
  const now = opts.now ?? new Date();
  return inTransaction(opts.session, async (s) => {
    const key = `reserve:${String(sessionId)}`;
    const existing = await findEntry(key, s);
    if (existing) return { lotId: existing.lotId!, created: false };
    const account = await loadAccount(userId, s);
    const lot = pickLot(account.lots, now);
    if (!lot) throw new InsufficientCreditsError();
    // loadAccount already wrote to the account in this transaction, so a concurrent
    // reservation gets a WriteConflict and the driver retries it with fresh data.
    await CreditAccountModel.updateOne(
      { userId: oid(userId) },
      { $inc: { balance: -1, reserved: 1, version: 1, 'lots.$[lot].remaining': -1 } },
      { session: s, arrayFilters: [{ 'lot.lotId': lot.lotId }] },
    );
    await CreditLedgerModel.create(
      [
        {
          userId: oid(userId),
          type: 'INTERVIEW_RESERVE',
          amount: -1,
          reservedDelta: 1,
          lotId: lot.lotId,
          refType: 'interviewSession',
          refId: String(sessionId),
          idempotencyKey: key,
        },
      ],
      { session: s },
    );
    return { lotId: lot.lotId, created: true };
  });
}

export type SettleOutcome = 'CONSUME' | 'REFUND';

/**
 * Consumes or refunds an interview's reserved credit, exactly once. Returns
 * what happened: null when nothing was reserved, otherwise the entry type and
 * whether this call created it.
 */
export async function settleCredit(
  userId: Id,
  sessionId: Id,
  outcome: SettleOutcome,
  opts: { session?: ClientSession; reason?: string | null } = {},
): Promise<{ type: CreditLedgerRecord['type']; created: boolean } | null> {
  return inTransaction(opts.session, async (s) => {
    const key = `settle:${String(sessionId)}`;
    // Lock the account first so a concurrent consume and refund serialise here.
    await loadAccount(userId, s);
    const existing = await findEntry(key, s);
    if (existing) return { type: existing.type, created: false };
    const reserve = await findEntry(`reserve:${String(sessionId)}`, s);
    if (!reserve) return null;
    const refund = outcome === 'REFUND';
    await CreditLedgerModel.create(
      [
        {
          userId: oid(userId),
          type: refund ? 'INTERVIEW_REFUND' : 'INTERVIEW_CONSUME',
          amount: refund ? 1 : 0,
          reservedDelta: -1,
          lotId: reserve.lotId,
          refType: 'interviewSession',
          refId: String(sessionId),
          idempotencyKey: key,
          reason: opts.reason ?? null,
        },
      ],
      { session: s },
    );
    await CreditAccountModel.updateOne(
      { userId: oid(userId) },
      refund
        ? { $inc: { balance: 1, reserved: -1, version: 1, 'lots.$[lot].remaining': 1 } }
        : { $inc: { reserved: -1, version: 1 } },
      { session: s, ...(refund ? { arrayFilters: [{ 'lot.lotId': reserve.lotId }] } : {}) },
    );
    return { type: refund ? 'INTERVIEW_REFUND' : 'INTERVIEW_CONSUME', created: true };
  });
}

/** Available and reserved credits, granting the FREE credit on first use. */
export async function getCreditBalance(userId: Id, now = new Date()): Promise<CreditBalance> {
  await grantFreeCredits(userId);
  const account = await CreditAccountModel.findOne({ userId: oid(userId) }).lean();
  const lots = (account?.lots ?? []).filter((l) => usable(l, now));
  return {
    available: lots.reduce((sum, l) => sum + l.remaining, 0),
    reserved: account?.reserved ?? 0,
    lots: lots.map((l) => ({
      source: l.source,
      remaining: l.remaining,
      expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
    })),
  };
}

/** Rebuilds an account from its ledger (the ledger is authoritative). */
export async function recomputeCreditAccount(userId: Id, session?: ClientSession) {
  return inTransaction(session, async (s) => {
    const entries = await CreditLedgerModel.find({ userId: oid(userId) }, null, { session: s })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const lots = new Map<string, CreditLotRecord>();
    let balance = 0;
    let reserved = 0;
    for (const e of entries) {
      balance += e.amount;
      reserved += e.reservedDelta;
      if (e.lotSource && e.lotId) {
        lots.set(String(e.lotId), {
          lotId: e.lotId,
          source: e.lotSource,
          remaining: e.amount,
          expiresAt: e.expiresAt,
        });
      } else if (e.lotId && lots.has(String(e.lotId))) {
        lots.get(String(e.lotId))!.remaining += e.amount;
      }
    }
    const account = await CreditAccountModel.findOneAndUpdate(
      { userId: oid(userId) },
      { $set: { balance, reserved, lots: [...lots.values()] }, $inc: { version: 1 } },
      { upsert: true, returnDocument: 'after', session: s },
    ).lean();
    return account!;
  });
}

/**
 * Withdraws whatever is left of a lot (e.g. after a refund). Credits already
 * spent or reserved by an interview in progress are not touched. Returns the
 * number withdrawn; idempotent per key.
 */
export async function revokeLotCredits(
  userId: Id,
  lotId: Id,
  idempotencyKey: string,
  reason: string,
  session?: ClientSession,
): Promise<number> {
  return inTransaction(session, async (s) => {
    const account = await loadAccount(userId, s);
    if (await findEntry(idempotencyKey, s)) return 0;
    const lot = account.lots.find((l) => String(l.lotId) === String(lotId));
    const remaining = lot?.remaining ?? 0;
    await CreditLedgerModel.create(
      [
        {
          userId: oid(userId),
          type: 'ADMIN_ADJUSTMENT',
          amount: -remaining,
          reservedDelta: 0,
          lotId: oid(lotId),
          refType: 'lot',
          refId: String(lotId),
          idempotencyKey,
          reason,
        },
      ],
      { session: s },
    );
    if (remaining > 0) {
      await CreditAccountModel.updateOne(
        { userId: oid(userId) },
        { $inc: { balance: -remaining, version: 1, 'lots.$[lot].remaining': -remaining } },
        { session: s, arrayFilters: [{ 'lot.lotId': oid(lotId) }] },
      );
    }
    return remaining;
  });
}
