import { createLogger } from '@cbi/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureCommerceCatalog,
  expirePurchase,
  getCreditBalance,
  markPurchaseFailed,
  markPurchasePaid,
  markPurchaseRefunded,
  recomputeCreditAccount,
  reserveCredit,
} from './index.js';
import { connectMongo, disconnectMongo, mongoose } from './mongo.js';
import { ensureIndexes } from './indexes.js';
import {
  CouponModel,
  CouponRedemptionModel,
  PaymentModel,
  PlanModel,
  PurchaseModel,
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
) {
  const plan = (await PlanModel.findOne({ code: planCode, active: true }).lean())!;
  const userId = newId();
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
    expect(first.refunded).toBe(true);
    expect(first.creditsWithdrawn).toBe(2);
    expect(
      await markPurchaseRefunded({ purchaseId, refundId: 'rfnd_1', source: 'WEBHOOK' }),
    ).toEqual({ refunded: false, creditsWithdrawn: 0 });

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
