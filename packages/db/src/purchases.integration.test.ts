import { createLogger } from '@cbi/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adjustCredits,
  claimRefund,
  CouponUnavailableError,
  couponUsesHeld,
  ensureCommerceCatalog,
  ensureCouponCounter,
  expirePurchase,
  getCreditBalance,
  grantFreeCredits,
  inTransaction,
  InsufficientCreditsError,
  issueInvoiceNumber,
  lotUsage,
  markPurchaseFailed,
  markPurchasePaid,
  markPurchaseRefunded,
  markRefundFailed,
  markRefundPending,
  recomputeCreditAccount,
  releaseRefundClaim,
  reserveCoupon,
  reserveCredit,
} from './index.js';
import { connectMongo, disconnectMongo, mongoose } from './mongo.js';
import { ensureIndexes } from './indexes.js';
import {
  CouponModel,
  CouponRedemptionModel,
  CouponUserUsageModel,
  PaymentModel,
  PlanModel,
  PurchaseModel,
  type CouponRecord,
} from './models/commerce.js';
import { CreditAccountModel, CreditLedgerModel } from './models/credits.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need MONGODB_URI pointing at a database whose name contains "test".',
  );
}

beforeAll(async () => {
  await connectMongo({
    uri: MONGODB_URI,
    autoIndex: false,
    logger: createLogger({ service: 'test', level: 'silent' }),
  });
  await ensureIndexes();
});
beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray())
    await db.collection(name).deleteMany({});
  await ensureCommerceCatalog();
});
afterAll(disconnectMongo);

const newId = () => new mongoose.Types.ObjectId();
const NOW = new Date(Date.UTC(2026, 8, 24, 10, 0, 0));

async function createPurchase(
  planCode = 'SPRINT',
  couponId: mongoose.Types.ObjectId | null = null,
  userId = newId(),
) {
  const plan = (await PlanModel.findOne({ code: planCode, active: true }).lean())!;
  const purchase = await PurchaseModel.create({
    userId,
    planId: plan._id,
    plan: {
      code: plan.code,
      version: plan.version,
      name: plan.name,
      credits: plan.credits,
      validityDays: plan.validityDays,
    },
    couponId,
    couponCode: couponId ? 'WELCOME' : null,
    listPriceMinor: plan.priceMinor,
    discountMinor: 0,
    amountMinor: plan.priceMinor,
    currency: 'INR',
    statusHistory: [{ status: 'CREATED', at: NOW, source: 'ORDER' }],
  });
  await PaymentModel.create({
    purchaseId: purchase._id,
    userId,
    provider: 'mock',
    orderId: `order_${String(purchase._id)}`,
    amountMinor: plan.priceMinor,
    currency: 'INR',
    statusHistory: [{ status: 'CREATED', at: NOW, source: 'ORDER' }],
  });
  return { userId, purchaseId: purchase._id };
}

/** What the API does at order time: the purchase and its coupon use in one transaction. */
async function orderWithCoupon(coupon: CouponRecord, userId: mongoose.Types.ObjectId) {
  await ensureCouponCounter(coupon._id, userId);
  const plan = (await PlanModel.findOne({ code: 'SPRINT', active: true }).lean())!;
  return inTransaction(undefined, async (tx) => {
    const [purchase] = await PurchaseModel.create(
      [
        {
          userId,
          planId: plan._id,
          plan: { code: plan.code, version: plan.version, name: plan.name, credits: 3 },
          couponId: coupon._id,
          couponCode: coupon.code,
          listPriceMinor: plan.priceMinor,
          discountMinor: 0,
          amountMinor: plan.priceMinor,
          currency: 'INR',
        },
      ],
      { session: tx },
    );
    await reserveCoupon({ coupon, userId, purchaseId: purchase!._id }, tx);
    await PaymentModel.create(
      [
        {
          purchaseId: purchase!._id,
          userId,
          provider: 'mock',
          orderId: `order_${String(purchase!._id)}`,
          amountMinor: plan.priceMinor,
          currency: 'INR',
        },
      ],
      { session: tx },
    );
    return purchase!._id;
  });
}

const rejectedWith = (results: PromiseSettledResult<unknown>[]) =>
  results.flatMap((r) =>
    r.status === 'rejected' && r.reason instanceof CouponUnavailableError ? [r.reason.reason] : [],
  );

/** A paid SPRINT purchase (₹199, 3 credits) with gateway payment `pay_1`. */
async function paidPurchase() {
  const p = await createPurchase();
  await PaymentModel.updateOne({ purchaseId: p.purchaseId }, { $set: { paymentId: 'pay_1' } });
  await markPurchasePaid({ purchaseId: p.purchaseId, source: 'VERIFY', now: NOW });
  return p;
}

describe('catalog', () => {
  it('seeds each plan once and keeps plan versions immutable', async () => {
    expect(await ensureCommerceCatalog()).toBe(0);
    expect(await PlanModel.countDocuments({ active: true })).toBe(3);
    await expect(
      PlanModel.updateOne({ code: 'SPRINT' }, { $set: { priceMinor: 1 } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      PlanModel.create({
        code: 'SPRINT',
        version: 2,
        active: true,
        name: 'x',
        priceMinor: 1,
        currency: 'INR',
        credits: 1,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe('markPurchasePaid', () => {
  it('issues the plan credits exactly once, with the plan validity', async () => {
    const { userId, purchaseId } = await createPurchase();
    const first = await markPurchasePaid({
      purchaseId,
      source: 'VERIFY',
      paymentId: 'pay_1',
      signatureVerified: true,
      now: NOW,
    });
    expect(first.issued).toBe(true);
    expect(first.purchase).toMatchObject({ status: 'PAID' });
    expect((await markPurchasePaid({ purchaseId, source: 'WEBHOOK', now: NOW })).issued).toBe(
      false,
    );
    const ledger = await CreditLedgerModel.find({ userId, type: 'PURCHASE' }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 3, idempotencyKey: `purchase:${purchaseId}` });
    const account = (await CreditAccountModel.findOne({ userId }).lean())!;
    expect(account.lots[0]!.expiresAt!.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
    const payment = (await PaymentModel.findOne({ purchaseId }).lean())!;
    expect(payment).toMatchObject({
      status: 'CAPTURED',
      paymentId: 'pay_1',
      signatureVerified: true,
    });
    const purchase = (await PurchaseModel.findById(purchaseId).lean())!;
    expect(String(purchase.creditLotId)).toBe(String(ledger[0]!.lotId));
  });

  it('issues once when verify, webhook and reconciliation race', async () => {
    const { userId, purchaseId } = await createPurchase('JOB_HUNT');
    const results = await Promise.all(
      (['VERIFY', 'WEBHOOK', 'RECONCILE', 'WEBHOOK', 'VERIFY'] as const).map((source) =>
        markPurchasePaid({ purchaseId, source, now: NOW }),
      ),
    );
    expect(results.filter((r) => r.issued)).toHaveLength(1);
    expect(await CreditLedgerModel.countDocuments({ userId, type: 'PURCHASE' })).toBe(1);
    // 12 purchased + the free credit.
    expect((await getCreditBalance(userId, NOW)).available).toBe(13);
    const purchase = (await PurchaseModel.findById(purchaseId).lean())!;
    expect(purchase.statusHistory.filter((h) => h.status === 'PAID')).toHaveLength(1);
  });

  it('accepts a later success after a failed attempt or expiry', async () => {
    const a = await createPurchase();
    expect(await markPurchaseFailed({ purchaseId: a.purchaseId, source: 'WEBHOOK' })).toBe(true);
    expect(await markPurchaseFailed({ purchaseId: a.purchaseId, source: 'WEBHOOK' })).toBe(false);
    expect((await markPurchasePaid({ purchaseId: a.purchaseId, source: 'WEBHOOK' })).issued).toBe(
      true,
    );
    // A paid purchase can no longer fail or expire.
    expect(await markPurchaseFailed({ purchaseId: a.purchaseId, source: 'WEBHOOK' })).toBe(false);
    expect(await expirePurchase(a.purchaseId)).toBe(false);

    const b = await createPurchase();
    expect(await expirePurchase(b.purchaseId)).toBe(true);
    expect((await markPurchasePaid({ purchaseId: b.purchaseId, source: 'RECONCILE' })).issued).toBe(
      true,
    );
  });

  it('records the coupon redemption with the payment, once', async () => {
    const coupon = await CouponModel.create({ code: 'WELCOME', type: 'PERCENT', value: 20 });
    const { userId, purchaseId } = await createPurchase('SPRINT', coupon._id);
    await Promise.all([
      markPurchasePaid({ purchaseId, source: 'VERIFY' }),
      markPurchasePaid({ purchaseId, source: 'WEBHOOK' }),
    ]);
    expect(await CouponRedemptionModel.countDocuments({ couponId: coupon._id, userId })).toBe(1);
    expect((await CouponModel.findById(coupon._id).lean())!.usedCount).toBe(1);
    expect(await couponUsesHeld(coupon._id, userId)).toBe(1);
  });

  it('numbers invoices consecutively per financial year, once per purchase', async () => {
    const a = await createPurchase();
    const b = await createPurchase();
    const [first] = await Promise.all([
      markPurchasePaid({ purchaseId: a.purchaseId, source: 'VERIFY', now: NOW }),
      markPurchasePaid({ purchaseId: b.purchaseId, source: 'WEBHOOK', now: NOW }),
    ]);
    expect(first.purchase!.invoiceNumber).toMatch(/^CPI\/26-27\/00000[12]$/);
    const numbers = (await PurchaseModel.find({}, { invoiceNumber: 1 }).lean())
      .map((p) => p.invoiceNumber)
      .sort();
    expect(numbers).toEqual(['CPI/26-27/000001', 'CPI/26-27/000002']);
    // Issuing again (e.g. for a legacy purchase at download time) keeps the number.
    await Promise.all([issueInvoiceNumber(a.purchaseId), issueInvoiceNumber(a.purchaseId)]);
    expect((await PurchaseModel.findById(a.purchaseId).lean())!.invoiceNumber).toBe(
      first.purchase!.invoiceNumber,
    );
    // Unpaid purchases get none.
    const c = await createPurchase();
    expect(await issueInvoiceNumber(c.purchaseId)).toBeNull();
  });
});

describe('coupon reservations', () => {
  it('never lets concurrent orders exceed maxUses', async () => {
    const coupon = (
      await CouponModel.create({ code: 'FIRST2', type: 'PERCENT', value: 10, maxUses: 2 })
    ).toObject();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => orderWithCoupon(coupon, newId())),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(rejectedWith(results)).toEqual(['USED_UP', 'USED_UP', 'USED_UP', 'USED_UP']);
    expect((await CouponModel.findById(coupon._id).lean())!.usedCount).toBe(2);
    expect(await CouponRedemptionModel.countDocuments({ couponId: coupon._id })).toBe(2);
    // The losers' purchases were rolled back with their transactions.
    expect(await PurchaseModel.countDocuments({ couponId: coupon._id })).toBe(2);
  });

  it('never lets one user hold more than perUserLimit, even with parallel orders', async () => {
    const coupon = (
      await CouponModel.create({ code: 'TWICE', type: 'PERCENT', value: 10, perUserLimit: 2 })
    ).toObject();
    const userId = newId();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => orderWithCoupon(coupon, userId)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(rejectedWith(results)).toEqual(['ALREADY_USED', 'ALREADY_USED', 'ALREADY_USED']);
    expect(await couponUsesHeld(coupon._id, userId)).toBe(2);
    // The rolled-back transactions gave the total count back.
    expect((await CouponModel.findById(coupon._id).lean())!.usedCount).toBe(2);
    expect(await CouponUserUsageModel.countDocuments({ couponId: coupon._id })).toBe(1);
    // Another user is unaffected.
    await orderWithCoupon(coupon, newId());
  });

  it('counts redemptions made before counters existed', async () => {
    const coupon = (
      await CouponModel.create({ code: 'LEGACY', type: 'PERCENT', value: 10, usedCount: 1 })
    ).toObject();
    const userId = newId();
    await CouponRedemptionModel.collection.insertOne({
      couponId: coupon._id,
      userId,
      purchaseId: newId(),
      createdAt: NOW,
    });
    expect(await couponUsesHeld(coupon._id, userId)).toBe(1);
    await expect(orderWithCoupon(coupon, userId)).rejects.toMatchObject({
      reason: 'ALREADY_USED',
    });
  });

  it('redeems on payment and releases on expiry, failed order creation and full refund', async () => {
    const coupon = (
      await CouponModel.create({ code: 'CYCLE', type: 'PERCENT', value: 10, maxUses: 1 })
    ).toObject();
    const usedCount = async () => (await CouponModel.findById(coupon._id).lean())!.usedCount;
    const status = async (purchaseId: mongoose.Types.ObjectId) =>
      (await CouponRedemptionModel.findOne({ purchaseId }).lean())!.status;

    // An order that expires gives its use back.
    const userId = newId();
    const expiring = await orderWithCoupon(coupon, userId);
    expect(await status(expiring)).toBe('RESERVED');
    expect(await expirePurchase(expiring, NOW)).toBe(true);
    expect(await status(expiring)).toBe('RELEASED');
    expect(await usedCount()).toBe(0);
    expect(await couponUsesHeld(coupon._id, userId)).toBe(0);

    // A failed payment attempt keeps it (the order can still be paid)...
    const attempt = await orderWithCoupon(coupon, userId);
    await markPurchaseFailed({ purchaseId: attempt, source: 'WEBHOOK' });
    expect(await status(attempt)).toBe('RESERVED');
    // ...and paying redeems it.
    await markPurchasePaid({ purchaseId: attempt, source: 'WEBHOOK', now: NOW });
    expect(await status(attempt)).toBe('REDEEMED');
    expect(await usedCount()).toBe(1);

    // A full refund gives it back.
    await PaymentModel.updateOne({ purchaseId: attempt }, { $set: { paymentId: 'pay_c' } });
    await markPurchaseRefunded({ purchaseId: attempt, refundId: 'rfnd_c', source: 'WEBHOOK' });
    expect(await status(attempt)).toBe('RELEASED');
    expect(await usedCount()).toBe(0);

    // No gateway order was created: released at once.
    const noOrder = await orderWithCoupon(coupon, newId());
    await markPurchaseFailed({ purchaseId: noOrder, source: 'ORDER' });
    expect(await status(noOrder)).toBe('RELEASED');
    expect(await usedCount()).toBe(0);
  });

  it('records a late payment after expiry even when the coupon is used up meanwhile', async () => {
    const coupon = (
      await CouponModel.create({ code: 'LATE', type: 'PERCENT', value: 10, maxUses: 1 })
    ).toObject();
    const late = await orderWithCoupon(coupon, newId());
    await expirePurchase(late, NOW);
    await orderWithCoupon(coupon, newId()); // takes the freed use
    // The first customer pays after all: the money is taken, so the use is recorded.
    expect((await markPurchasePaid({ purchaseId: late, source: 'RECONCILE' })).issued).toBe(true);
    expect((await CouponRedemptionModel.findOne({ purchaseId: late }).lean())!.status).toBe(
      'REDEEMED',
    );
    expect((await CouponModel.findById(coupon._id).lean())!.usedCount).toBe(2);
  });
});

describe('refund claims', () => {
  const claim = (purchaseId: mongoose.Types.ObjectId, amountMinor = 19_900) =>
    claimRefund({
      purchaseId,
      amountMinor,
      creditsToWithdraw: 3,
      reason: 'Customer request',
      actorId: null,
    });

  it('lets exactly one of concurrent refund requests claim the payment', async () => {
    const { purchaseId } = await paidPurchase();
    const claims = await Promise.all([claim(purchaseId), claim(purchaseId), claim(purchaseId)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const payment = (await PaymentModel.findOne({ purchaseId }).lean())!;
    expect(payment.status).toBe('REFUND_REQUESTED');
    expect(payment.refunds).toHaveLength(1);
    // Released after a gateway refusal, it can be claimed again.
    const won = claims.find(Boolean)!;
    expect(await releaseRefundClaim({ purchaseId, key: won.key })).toBe(true);
    expect(await releaseRefundClaim({ purchaseId, key: won.key })).toBe(false);
    expect(await claim(purchaseId)).not.toBeNull();
  });

  it('refuses a claim for more than is left to refund', async () => {
    const { purchaseId } = await paidPurchase();
    expect(await claim(purchaseId, 20_000)).toBeNull();
    expect((await PaymentModel.findOne({ purchaseId }).lean())!.status).toBe('CAPTURED');
  });

  it('adds partial refunds up to the full amount, withdrawing the credits chosen', async () => {
    const { userId, purchaseId } = await paidPurchase();
    const first = await claimRefund({
      purchaseId,
      amountMinor: 6_633,
      creditsToWithdraw: 1,
      reason: 'One credit back',
      actorId: null,
    });
    await markRefundPending({
      purchaseId,
      key: first!.key,
      refundId: 'rfnd_a',
      amountMinor: 6_633,
    });
    expect(
      await markPurchaseRefunded({ purchaseId, refundId: 'rfnd_a', source: 'WEBHOOK' }),
    ).toEqual({ refunded: true, fully: false, creditsWithdrawn: 1 });
    expect((await PurchaseModel.findById(purchaseId).lean())!.status).toBe('PAID');
    expect((await PaymentModel.findOne({ purchaseId }).lean())!).toMatchObject({
      status: 'CAPTURED',
      refundedMinor: 6_633,
    });
    const lot = (await PurchaseModel.findById(purchaseId).lean())!.creditLotId!;
    expect(await lotUsage(userId, lot, NOW)).toMatchObject({
      granted: 3,
      remaining: 2,
      withdrawn: 1,
      used: 0,
    });

    // The rest completes the full amount, so every unused credit goes.
    expect(await claim(purchaseId, 13_268)).toBeNull();
    const rest = await claim(purchaseId, 13_267);
    await markRefundPending({
      purchaseId,
      key: rest!.key,
      refundId: 'rfnd_b',
      amountMinor: 13_267,
    });
    expect(await markPurchaseRefunded({ purchaseId, refundId: 'rfnd_b', source: 'ADMIN' })).toEqual(
      { refunded: true, fully: true, creditsWithdrawn: 2 },
    );
    expect((await PurchaseModel.findById(purchaseId).lean())!.status).toBe('REFUNDED');
    expect((await PaymentModel.findOne({ purchaseId }).lean())!).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: 19_900,
    });
  });

  it('flags a failed refund and reopens the payment', async () => {
    const { purchaseId } = await paidPurchase();
    const c = await claim(purchaseId);
    await markRefundPending({ purchaseId, key: c!.key, refundId: 'rfnd_x', amountMinor: 19_900 });
    expect(await markRefundFailed({ paymentId: 'pay_1', refundId: 'rfnd_x' })).toMatchObject({
      amountMinor: 19_900,
    });
    expect(await markRefundFailed({ paymentId: 'pay_1', refundId: 'rfnd_x' })).toBeNull();
    const payment = (await PaymentModel.findOne({ purchaseId }).lean())!;
    expect(payment).toMatchObject({ status: 'CAPTURED', refundFailed: true, refundedMinor: 0 });
    expect(payment.refunds[0]!.status).toBe('failed');
    // A new request clears the flag.
    await claim(purchaseId);
    expect((await PaymentModel.findOne({ purchaseId }).lean())!.refundFailed).toBe(false);
  });
});

describe('adjustCredits', () => {
  it('grants and deducts by hand, never below what is usable', async () => {
    const userId = newId();
    const actorId = newId();
    await grantFreeCredits(userId);
    const adjust = (delta: number, idempotencyKey: string) =>
      adjustCredits({ userId, delta, reason: 'Support case', actorId, idempotencyKey });
    expect(await adjust(2, 'adj:1')).toBe(true);
    expect(await adjust(2, 'adj:1')).toBe(false);
    expect((await getCreditBalance(userId)).available).toBe(3);
    // A deduction spans lots (one entry per lot touched).
    expect(await adjust(-2, 'adj:2')).toBe(true);
    expect((await getCreditBalance(userId)).available).toBe(1);
    await expect(adjust(-2, 'adj:3')).rejects.toBeInstanceOf(InsufficientCreditsError);
    const entries = await CreditLedgerModel.find({ userId, type: 'ADMIN_ADJUSTMENT' }).lean();
    expect(entries.reduce((sum, e) => sum + e.amount, 0)).toBe(0);
    expect(entries.every((e) => String(e.actorId) === String(actorId))).toBe(true);
    // The projection rebuilt from the ledger agrees.
    await recomputeCreditAccount(userId);
    expect((await getCreditBalance(userId)).available).toBe(1);
  });
});

describe('markPurchaseRefunded', () => {
  it('withdraws the unused credits of the purchase once, leaving spent ones', async () => {
    const { userId, purchaseId } = await createPurchase();
    await markPurchasePaid({ purchaseId, source: 'VERIFY', now: NOW });
    // An interview in progress holds one purchased credit (earliest-expiring lot first).
    await reserveCredit(userId, newId(), { now: NOW });
    const before = await getCreditBalance(userId, NOW);

    const first = await markPurchaseRefunded({ purchaseId, refundId: 'rfnd_1', source: 'WEBHOOK' });
    expect(first).toEqual({ refunded: true, fully: true, creditsWithdrawn: 2 });
    expect(
      await markPurchaseRefunded({ purchaseId, refundId: 'rfnd_1', source: 'WEBHOOK' }),
    ).toEqual({ refunded: false, fully: false, creditsWithdrawn: 0 });

    const after = await getCreditBalance(userId, NOW);
    expect(before.available).toBe(3); // 2 purchased + the free credit
    expect(after.available).toBe(1);
    expect(after.reserved).toBe(1);
    expect((await PaymentModel.findOne({ purchaseId }).lean())!).toMatchObject({
      status: 'REFUNDED',
      refund: { id: 'rfnd_1', status: 'processed' },
    });
    // The projection rebuilt from the ledger agrees.
    const projected = (await CreditAccountModel.findOne({ userId }).lean())!;
    await recomputeCreditAccount(userId);
    const rebuilt = (await CreditAccountModel.findOne({ userId }).lean())!;
    expect(rebuilt.balance).toBe(projected.balance);
    expect(rebuilt.reserved).toBe(projected.reserved);
  });
});
