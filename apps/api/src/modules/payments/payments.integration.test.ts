import {
  AuditLogModel,
  CouponModel,
  CreditLedgerModel,
  ensureCommerceCatalog,
  PurchaseModel,
  UserModel,
  UserProfileModel,
  WebhookEventModel,
} from '@cbi/db';
import {
  AdminPurchase,
  CheckoutOrder,
  PlanSummary,
  PublicPlan,
  PurchaseSummary,
  Quote,
  type AdminRole,
} from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';
import { priceWithCoupon } from './payments.service.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
  await ensureCommerceCatalog();
});

type Method = 'get' | 'post' | 'put';

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { call, userId: String(user.id) };
}

async function adminAs(roles: AdminRole[], email = `${roles[0]!.toLowerCase()}@codebegun.com`) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'admin');
  const call = (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1/admin${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { call, userId: String(user._id) };
}

/** Delivers a signed webhook exactly as the gateway would (raw JSON body, no Origin). */
function deliver(hook: { body: Buffer; signature: string; eventId: string }) {
  return (
    request(t.app)
      .post('/api/v1/payments/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', hook.signature)
      .set('X-Razorpay-Event-Id', hook.eventId)
      // A string goes out byte for byte (supertest would JSON-encode a Buffer).
      .send(hook.body.toString('utf8'))
  );
}

async function order(
  c: Awaited<ReturnType<typeof candidate>>,
  planCode = 'SPRINT',
  couponCode: string | null = null,
) {
  const res = await c.call('post', '/payments/orders').send({ planCode, couponCode }).expect(201);
  return CheckoutOrder.parse(res.body.data);
}

const purchaseCredits = (userId: string) =>
  CreditLedgerModel.countDocuments({ userId, type: 'PURCHASE' });

async function balance(c: Awaited<ReturnType<typeof candidate>>) {
  return (await c.call('get', '/credits/balance').expect(200)).body.data.available as number;
}

describe('pricing', () => {
  it('lists active plans publicly and refuses to sell the free plan', async () => {
    const res = await request(t.app).get('/api/v1/plans').expect(200);
    const plans = z.array(PublicPlan).parse(res.body.data);
    expect(plans.map((p) => p.code)).toEqual(['FREE', 'SPRINT', 'JOB_HUNT']);
    const c = await candidate();
    await c
      .call('post', '/payments/quote')
      .send({ planCode: 'FREE' })
      .expect(409)
      .expect((r) => expect(r.body.error.code).toBe('INVALID_STATE'));
    await c.call('post', '/payments/quote').send({ planCode: 'NOPE' }).expect(404);
  });

  it('prices coupons on the server and floors non-zero totals at ₹1', () => {
    expect(priceWithCoupon(19_900, { type: 'PERCENT', value: 25 })).toEqual({
      discountMinor: 4_975,
      totalMinor: 14_925,
    });
    expect(priceWithCoupon(19_900, { type: 'FIXED', value: 50_000 })).toEqual({
      discountMinor: 19_900,
      totalMinor: 0,
    });
    expect(priceWithCoupon(19_900, { type: 'FIXED', value: 19_850 })).toEqual({
      discountMinor: 19_800,
      totalMinor: 100,
    });
    expect(priceWithCoupon(19_900, { type: 'PERCENT', value: 100 }).totalMinor).toBe(0);
  });

  it('explains why a coupon does not apply', async () => {
    const past = new Date(Date.now() - 86_400_000);
    await CouponModel.create([
      { code: 'SAVE20', type: 'PERCENT', value: 20 },
      { code: 'OLD', type: 'PERCENT', value: 20, validTo: past },
      { code: 'LATER', type: 'PERCENT', value: 20, validFrom: new Date(Date.now() + 86_400_000) },
      { code: 'HUNTONLY', type: 'FIXED', value: 5_000, planCodes: ['JOB_HUNT'] },
      { code: 'GONE', type: 'PERCENT', value: 10, maxUses: 5, usedCount: 5 },
      { code: 'OFF', type: 'PERCENT', value: 10, active: false },
    ]);
    const c = await candidate();
    const quote = async (couponCode: string) =>
      Quote.parse(
        (
          await c
            .call('post', '/payments/quote')
            .send({ planCode: 'SPRINT', couponCode })
            .expect(200)
        ).body.data,
      );
    expect(await quote('save20')).toMatchObject({
      listPriceMinor: 19_900,
      discountMinor: 3_980,
      totalMinor: 15_920,
      coupon: { code: 'SAVE20', applied: true, rejection: null },
    });
    for (const [code, rejection] of [
      ['NOSUCH', 'NOT_FOUND'],
      ['OLD', 'EXPIRED'],
      ['LATER', 'NOT_STARTED'],
      ['HUNTONLY', 'NOT_FOR_PLAN'],
      ['GONE', 'USED_UP'],
      ['OFF', 'INACTIVE'],
    ]) {
      expect(await quote(code!)).toMatchObject({
        totalMinor: 19_900,
        coupon: { applied: false, rejection },
      });
    }
    // An order with a coupon that does not apply is refused rather than silently charged in full.
    await c
      .call('post', '/payments/orders')
      .send({ planCode: 'SPRINT', couponCode: 'OLD' })
      .expect(400)
      .expect((r) => expect(r.body.error.details).toEqual({ rejection: 'EXPIRED' }));
  });
});

describe('checkout', () => {
  it('opens an order, verifies the Checkout result and issues credits once', async () => {
    const c = await candidate();
    const before = await balance(c);
    const created = await order(c);
    expect(created).toMatchObject({
      status: 'CREATED',
      totalMinor: 19_900,
      provider: { name: 'mock', keyId: 'rzp_test_mock' },
    });
    const { checkout } = t.payments.pay(created.provider!.orderId);

    const verified = await c.call('post', '/payments/verify').send(checkout).expect(200);
    expect(PurchaseSummary.parse(verified.body.data)).toMatchObject({
      status: 'PAID',
      plan: { code: 'SPRINT', credits: 3 },
    });
    // The page may retry verify; nothing is issued twice.
    await c.call('post', '/payments/verify').send(checkout).expect(200);
    expect(await purchaseCredits(c.userId)).toBe(1);
    expect(await balance(c)).toBe(before + 3);

    const history = await c.call('get', '/payments/purchases').expect(200);
    expect(history.body.data).toHaveLength(1);
    await c.call('get', `/payments/purchases/${created.purchaseId}`).expect(200);
    // Other users cannot see the purchase or verify its order.
    const other = await candidate('ravi@example.com');
    await other.call('get', `/payments/purchases/${created.purchaseId}`).expect(404);
    await other.call('post', '/payments/verify').send(checkout).expect(404);
  });

  it('rejects forged signatures and amounts that do not match the order', async () => {
    const c = await candidate();
    const created = await order(c);
    const { checkout } = t.payments.pay(created.provider!.orderId, { amountMinor: 100 });
    await c
      .call('post', '/payments/verify')
      .send({ ...checkout, razorpay_signature: 'a'.repeat(64) })
      .expect(400)
      .expect((r) => expect(r.body.error.code).toBe('PAYMENT_VERIFICATION_FAILED'));
    // Validly signed, but only ₹1 was captured for a ₹199 order.
    await c.call('post', '/payments/verify').send(checkout).expect(400);
    const hook = t.payments.webhook('payment.captured', {
      payment: t.payments.payments.get(checkout.razorpay_payment_id)!,
    });
    expect((await deliver(hook).expect(200)).body.data.result).toBe('AMOUNT_MISMATCH');
    expect(await purchaseCredits(c.userId)).toBe(0);
    expect(
      await AuditLogModel.countDocuments({ action: 'payments.verify', outcome: 'FAILURE' }),
    ).toBe(2);
  });

  it('completes immediately when a coupon covers the whole price', async () => {
    await CouponModel.create({ code: 'FULL', type: 'PERCENT', value: 100 });
    const c = await candidate();
    const created = await order(c, 'JOB_HUNT', 'FULL');
    expect(created).toMatchObject({ status: 'PAID', totalMinor: 0, provider: null });
    expect(await purchaseCredits(c.userId)).toBe(1);
    // perUserLimit 1: the coupon is now used for this user.
    const again = await c
      .call('post', '/payments/quote')
      .send({ planCode: 'SPRINT', couponCode: 'FULL' })
      .expect(200);
    expect(again.body.data.coupon.rejection).toBe('ALREADY_USED');
    expect((await CouponModel.findOne({ code: 'FULL' }).lean())!.usedCount).toBe(1);
  });

  it('accepts a successful attempt after a failed one (mock Checkout)', async () => {
    const c = await candidate();
    const created = await order(c);
    const failed = await c
      .call('post', '/payments/mock/checkout')
      .send({ purchaseId: created.purchaseId, outcome: 'failure' })
      .expect(200);
    expect(failed.body.data).toMatchObject({ checkout: null, purchase: { status: 'FAILED' } });
    const ok = await c
      .call('post', '/payments/mock/checkout')
      .send({ purchaseId: created.purchaseId, outcome: 'success' })
      .expect(200);
    await c.call('post', '/payments/verify').send(ok.body.data.checkout).expect(200);
    expect(
      (await c.call('get', `/payments/purchases/${created.purchaseId}`)).body.data.status,
    ).toBe('PAID');
    await c
      .call('post', '/payments/mock/checkout')
      .send({ purchaseId: created.purchaseId, outcome: 'success' })
      .expect(409);
  });
});

describe('webhooks', () => {
  it('processes each event once and ignores redeliveries', async () => {
    const c = await candidate();
    const created = await order(c);
    const { payment } = t.payments.pay(created.provider!.orderId);
    const hook = t.payments.webhook('payment.captured', { payment });

    expect((await deliver(hook).expect(200)).body.data.result).toBe('PAID');
    expect((await deliver(hook).expect(200)).body.data.result).toBe('DUPLICATE');
    // order.paid for the same payment is a different event: recorded, but no second issue.
    const orderPaid = t.payments.webhook('order.paid', { payment });
    expect((await deliver(orderPaid).expect(200)).body.data.result).toBe('ALREADY_PAID');
    expect(await purchaseCredits(c.userId)).toBe(1);
    expect(await WebhookEventModel.countDocuments()).toBe(2);
  });

  it('refuses unsigned or tampered bodies', async () => {
    const c = await candidate();
    const created = await order(c);
    const { payment } = t.payments.pay(created.provider!.orderId);
    const hook = t.payments.webhook('payment.captured', { payment });
    await deliver({ ...hook, signature: 'b'.repeat(64) }).expect(400);
    const tampered = Buffer.from(hook.body.toString().replace('"captured"', '"captured" '));
    await deliver({ ...hook, body: tampered }).expect(400);
    await request(t.app)
      .post('/api/v1/payments/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .send(hook.body.toString('utf8'))
      .expect(400);
    expect(await WebhookEventModel.countDocuments()).toBe(0);
    expect(await purchaseCredits(c.userId)).toBe(0);
  });

  it('issues once when verify and webhooks race (double-issue guard)', async () => {
    const c = await candidate();
    const created = await order(c, 'JOB_HUNT');
    const { checkout, payment } = t.payments.pay(created.provider!.orderId);
    const captured = t.payments.webhook('payment.captured', { payment });
    const orderPaid = t.payments.webhook('order.paid', { payment });
    const responses = await Promise.all([
      c.call('post', '/payments/verify').send(checkout),
      deliver(captured),
      deliver(captured),
      deliver(orderPaid),
      c.call('post', '/payments/verify').send(checkout),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await purchaseCredits(c.userId)).toBe(1);
    const purchase = (await PurchaseModel.findById(created.purchaseId).lean())!;
    expect(purchase.statusHistory.filter((h) => h.status === 'PAID')).toHaveLength(1);
  });

  it('marks failed attempts and ignores unrelated events', async () => {
    const c = await candidate();
    const created = await order(c);
    const { payment } = t.payments.pay(created.provider!.orderId, { status: 'failed' });
    expect(
      (await deliver(t.payments.webhook('payment.failed', { payment })).expect(200)).body.data
        .result,
    ).toBe('FAILED');
    expect(
      (await deliver(t.payments.webhook('payment.authorized', { payment })).expect(200)).body.data
        .result,
    ).toBe('IGNORED');
    expect((await PurchaseModel.findById(created.purchaseId).lean())!.status).toBe('FAILED');
  });
});

describe('admin payments', () => {
  it('separates read (support) from manage (finance)', async () => {
    const support = await adminAs(['SUPPORT_ADMIN']);
    await support.call('get', '/purchases').expect(200);
    await support.call('get', '/plans').expect(200);
    await support
      .call('post', '/coupons')
      .send({ code: 'X10', type: 'PERCENT', value: 10 })
      .expect(403);
    const content = await adminAs(['CONTENT_ADMIN']);
    await content.call('get', '/purchases').expect(403);
  });

  it('versions plans: a new price takes effect only when activated', async () => {
    const finance = await adminAs(['FINANCE_ADMIN']);
    const created = await finance
      .call('post', '/plans')
      .send({
        code: 'SPRINT',
        reason: 'Festival pricing',
        content: {
          name: 'Sprint',
          description: 'Three interviews.',
          priceMinor: 14_900,
          currency: 'INR',
          credits: 3,
          validityDays: 7,
          features: ['3 practice interviews'],
          displayOrder: 10,
          featured: false,
        },
      })
      .expect(201);
    const plan = PlanSummary.parse(created.body.data);
    expect(plan).toMatchObject({ version: 2, active: false });

    const publicPrice = async () =>
      (await request(t.app).get('/api/v1/plans')).body.data.find(
        (p: { code: string }) => p.code === 'SPRINT',
      ).priceMinor;
    expect(await publicPrice()).toBe(19_900);
    await finance.call('post', `/plans/${plan.id}/activate`).send({ reason: 'Launch' }).expect(200);
    expect(await publicPrice()).toBe(14_900);
    const versions = z.array(PlanSummary).parse((await finance.call('get', '/plans')).body.data);
    expect(versions.filter((v) => v.code === 'SPRINT' && v.active)).toHaveLength(1);
    expect(await AuditLogModel.countDocuments({ action: /^payments\.plan\./ })).toBe(2);
  });

  it('creates and edits coupons with unique codes', async () => {
    const finance = await adminAs(['FINANCE_ADMIN']);
    const body = { code: 'launch-50', type: 'PERCENT', value: 50, maxUses: 100 };
    const created = await finance.call('post', '/coupons').send(body).expect(201);
    expect(created.body.data).toMatchObject({ code: 'LAUNCH-50', usedCount: 0 });
    await finance.call('post', '/coupons').send(body).expect(409);
    await finance
      .call('post', '/coupons')
      .send({ code: 'BAD', type: 'PERCENT', value: 150 })
      .expect(400);
    const updated = await finance
      .call('put', `/coupons/${created.body.data.id}`)
      .send({ ...body, active: false })
      .expect(200);
    expect(updated.body.data.active).toBe(false);
    await finance
      .call('put', `/coupons/${created.body.data.id}`)
      .send({ ...body, code: 'OTHER' })
      .expect(400);
  });

  it('refunds a purchase and withdraws its unused credits', async () => {
    const c = await candidate();
    const created = await order(c);
    const { checkout } = t.payments.pay(created.provider!.orderId);
    await c.call('post', '/payments/verify').send(checkout).expect(200);
    const before = await balance(c);

    const support = await adminAs(['SUPPORT_ADMIN']);
    await support
      .call('post', `/purchases/${created.purchaseId}/refund`)
      .send({ reason: 'Customer request' })
      .expect(403);
    const finance = await adminAs(['FINANCE_ADMIN']);
    const res = await finance
      .call('post', `/purchases/${created.purchaseId}/refund`)
      .send({ reason: 'Customer request' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      refundStatus: 'processed',
      creditsWithdrawn: 3,
      purchase: { status: 'REFUNDED', payment: { status: 'REFUNDED' } },
    });
    expect(await balance(c)).toBe(before - 3);
    await finance
      .call('post', `/purchases/${created.purchaseId}/refund`)
      .send({ reason: 'Again' })
      .expect(409);
    expect(await AuditLogModel.countDocuments({ action: 'payments.refund' })).toBe(1);

    const list = await finance.call('get', `/purchases?q=${c.userId}`).expect(200);
    expect(z.array(AdminPurchase).parse(list.body.data)).toHaveLength(1);
    const byEmail = await finance.call('get', '/purchases?q=asha@example.com').expect(200);
    expect(byEmail.body.data).toHaveLength(1);
  });

  it('reconciles a purchase whose browser and webhook never reported back', async () => {
    const c = await candidate();
    const created = await order(c);
    t.payments.pay(created.provider!.orderId); // paid at the gateway; nobody told us
    const finance = await adminAs(['FINANCE_ADMIN']);
    const res = await finance
      .call('post', `/purchases/${created.purchaseId}/reconcile`)
      .expect(200);
    expect(res.body.data).toMatchObject({ outcome: 'PAID', purchase: { status: 'PAID' } });
    expect(await purchaseCredits(c.userId)).toBe(1);
    const again = await finance
      .call('post', `/purchases/${created.purchaseId}/reconcile`)
      .expect(200);
    expect(again.body.data.outcome).toBe('UNCHANGED');
  });
});
