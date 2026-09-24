import { createLogger } from '@cbi/config';
import {
  connectMongo,
  CreditLedgerModel,
  disconnectMongo,
  ensureCommerceCatalog,
  ensureIndexes,
  markPurchasePaid,
  markRefundPending,
  mongoose,
  PaymentModel,
  PlanModel,
  PurchaseModel,
} from '@cbi/db';
import { createMockGateway } from '@cbi/provider-adapters';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcilePayments } from './payment-reconcile.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need MONGODB_URI pointing at a database whose name contains "test".',
  );
}

const logger = createLogger({ service: 'test', level: 'silent' });

beforeAll(async () => {
  await connectMongo({ uri: MONGODB_URI, autoIndex: false, logger });
  await ensureIndexes();
});
beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray())
    await db.collection(name).deleteMany({});
  await ensureCommerceCatalog();
});
afterAll(disconnectMongo);

const NOW = new Date('2026-09-24T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A SPRINT purchase created `createdAt`, with its order open at the mock gateway. */
async function openPurchase(mock: ReturnType<typeof createMockGateway>, createdAt: Date) {
  const plan = (await PlanModel.findOne({ code: 'SPRINT', active: true }).lean())!;
  const order = await mock.gateway.createOrder({
    amountMinor: plan.priceMinor,
    currency: 'INR',
    receipt: 'r',
  });
  const userId = new mongoose.Types.ObjectId();
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
    listPriceMinor: plan.priceMinor,
    discountMinor: 0,
    amountMinor: plan.priceMinor,
    currency: 'INR',
    statusHistory: [{ status: 'CREATED', at: createdAt, source: 'ORDER' }],
  });
  // Backdate (timestamps are set on create).
  await PurchaseModel.collection.updateOne({ _id: purchase._id }, { $set: { createdAt } });
  await PaymentModel.create({
    purchaseId: purchase._id,
    userId,
    provider: 'mock',
    orderId: order.id,
    amountMinor: plan.priceMinor,
    currency: 'INR',
  });
  return { purchaseId: purchase._id, orderId: order.id, userId };
}

const statusOf = async (id: mongoose.Types.ObjectId) =>
  (await PurchaseModel.findById(id).lean())!.status;

describe('reconcilePayments', () => {
  it('credits captured orders, expires stale ones and leaves recent ones alone', async () => {
    const mock = createMockGateway();
    const paidQuietly = await openPurchase(mock, minutesAgo(45));
    mock.pay(paidQuietly.orderId); // captured at the gateway; verify and webhook never arrived
    const waiting = await openPurchase(mock, minutesAgo(90));
    const abandoned = await openPurchase(mock, minutesAgo(25 * 60));
    const fresh = await openPurchase(mock, minutesAgo(5));
    mock.pay(fresh.orderId); // too recent: verify/webhook get their chance first

    const result = await reconcilePayments({ gateway: mock.gateway, logger, now: NOW });
    expect(result).toMatchObject({ checked: 3, PAID: 1, PENDING: 1, EXPIRED: 1, errors: 0 });
    expect(await statusOf(paidQuietly.purchaseId)).toBe('PAID');
    expect(await statusOf(waiting.purchaseId)).toBe('CREATED');
    expect(await statusOf(abandoned.purchaseId)).toBe('EXPIRED');
    expect(await statusOf(fresh.purchaseId)).toBe('CREATED');
    expect(
      await CreditLedgerModel.countDocuments({ userId: paidQuietly.userId, type: 'PURCHASE' }),
    ).toBe(1);

    // Running again changes nothing and issues nothing twice.
    const again = await reconcilePayments({ gateway: mock.gateway, logger, now: NOW });
    expect(again).toMatchObject({ PAID: 0, EXPIRED: 0 });
    expect(await CreditLedgerModel.countDocuments({ type: 'PURCHASE' })).toBe(1);
  });

  it('does not credit a capture for the wrong amount', async () => {
    const mock = createMockGateway();
    const p = await openPurchase(mock, minutesAgo(45));
    mock.pay(p.orderId, { amountMinor: 100 });
    const result = await reconcilePayments({ gateway: mock.gateway, logger, now: NOW });
    expect(result.AMOUNT_MISMATCH).toBe(1);
    expect(await statusOf(p.purchaseId)).toBe('CREATED');
    expect(await CreditLedgerModel.countDocuments({ type: 'PURCHASE' })).toBe(0);
  });

  it('completes refunds the gateway has processed', async () => {
    const mock = createMockGateway();
    const p = await openPurchase(mock, minutesAgo(10));
    const { payment } = mock.pay(p.orderId);
    await markPurchasePaid({ purchaseId: p.purchaseId, source: 'VERIFY', paymentId: payment.id });
    const refund = await mock.gateway.refund(payment.id, payment.amountMinor);
    await markRefundPending({ purchaseId: p.purchaseId, refundId: refund.id, amountMinor: 19_900 });

    const result = await reconcilePayments({ gateway: mock.gateway, logger, now: NOW });
    expect(result.REFUNDED).toBe(1);
    expect(await statusOf(p.purchaseId)).toBe('REFUNDED');
  });

  it('leaves purchases for the next run when the gateway is down', async () => {
    const mock = createMockGateway();
    await openPurchase(mock, minutesAgo(45));
    const down = {
      ...mock.gateway,
      fetchOrderPayments: () => Promise.reject(new Error('gateway down')),
    };
    const result = await reconcilePayments({ gateway: down, logger, now: NOW });
    expect(result).toMatchObject({ checked: 1, errors: 1 });
  });
});
