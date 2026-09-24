import {
  AdminPurchaseQuery,
  CreateOrderBody,
  CreatePlanVersionBody,
  MockCheckoutBody,
  PlanActivationBody,
  QuoteBody,
  RefundBody,
  UpsertCouponBody,
  VerifyPaymentBody,
  type MockCheckoutResult,
} from '@cbi/shared-types';
import express, { Router, type RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** `GET /plans`: the public pricing catalogue. */
export function plansRouter(c: Container): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60').json({ data: await c.payments.publicPlans() });
  });
  return router;
}

/** `/payments`: quotes, orders, verification and purchase history for the signed-in candidate. */
export function paymentsRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), noStore);

  router.post('/quote', c.limiters.payment, async (req, res) => {
    const body = QuoteBody.parse(req.body);
    res.json({ data: await c.payments.quote(requireAuth(req).userId, body) });
  });

  router.post('/orders', c.limiters.payment, async (req, res) => {
    const body = CreateOrderBody.parse(req.body);
    const order = await c.payments.createOrder(requireAuth(req).userId, body, clientContext(req));
    res.status(201).json({ data: order });
  });

  router.post('/verify', c.limiters.payment, async (req, res) => {
    const body = VerifyPaymentBody.parse(req.body);
    res.json({
      data: await c.payments.verify(requireAuth(req).userId, body, clientContext(req)),
    });
  });

  // DEVELOPMENT/TEST ONLY: completes mock Checkout (the mock gateway is refused elsewhere).
  router.post('/mock/checkout', c.limiters.payment, async (req, res) => {
    const mock = c.paymentMock;
    if (!mock || (c.env.APP_ENV !== 'development' && c.env.APP_ENV !== 'test')) {
      throw AppError.notFound();
    }
    const userId = requireAuth(req).userId;
    const body = MockCheckoutBody.parse(req.body);
    const orderId = await c.payments.orderIdFor(userId, body.purchaseId);
    const { checkout, payment } = mock.pay(orderId, {
      status: body.outcome === 'success' ? 'captured' : 'failed',
    });
    let data: MockCheckoutResult;
    if (body.outcome === 'success') {
      data = { checkout, purchase: await c.payments.get(userId, body.purchaseId) };
    } else {
      // A failed attempt reaches us only as a webhook, as with Razorpay.
      const hook = mock.webhook('payment.failed', { payment });
      await c.payments.handleWebhook(hook.body, hook.signature, hook.eventId);
      data = { checkout: null, purchase: await c.payments.get(userId, body.purchaseId) };
    }
    res.json({ data });
  });

  router.get('/purchases', async (req, res) => {
    res.json({ data: await c.payments.history(requireAuth(req).userId) });
  });

  router.get('/purchases/:purchaseId', async (req, res) => {
    res.json({
      data: await c.payments.get(requireAuth(req).userId, String(req.params.purchaseId)),
    });
  });

  return router;
}

/**
 * `POST /payments/webhooks/razorpay`. Mounted before the JSON parser: the
 * signature covers the exact bytes received. Always answers 200 once the
 * event is recorded (including duplicates and events we ignore) so the
 * gateway stops retrying; a processing error answers 500 so it retries.
 */
export function paymentWebhookHandler(c: Container): RequestHandler[] {
  return [
    express.raw({ type: () => true, limit: '256kb' }),
    async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await c.payments.handleWebhook(
        raw,
        req.get('x-razorpay-signature') ?? undefined,
        req.get('x-razorpay-event-id') ?? undefined,
      );
      if (result === 'INVALID_SIGNATURE') {
        throw new AppError(400, 'BAD_REQUEST', 'Invalid webhook signature');
      }
      res.set('Cache-Control', 'no-store').json({ data: { result } });
    },
  ];
}

/** Admin plans, coupons and purchases (mounted inside the admin router). */
export function paymentsAdminRouter(c: Container): Router {
  const router = Router();
  const read = requirePermission('payments.read');
  const manage = requirePermission('payments.manage');

  router.get('/plans', read, async (_req, res) => {
    res.json({ data: await c.payments.listPlans() });
  });

  router.post('/plans', manage, async (req, res) => {
    const body = CreatePlanVersionBody.parse(req.body);
    const plan = await c.payments.createPlanVersion(
      body,
      requireAuth(req).userId,
      clientContext(req),
    );
    res.status(201).json({ data: plan });
  });

  for (const [path, active] of [
    ['activate', true],
    ['deactivate', false],
  ] as const) {
    router.post(`/plans/:id/${path}`, manage, async (req, res) => {
      const { reason } = PlanActivationBody.parse(req.body);
      res.json({
        data: await c.payments.setPlanActive(
          String(req.params.id),
          active,
          reason,
          requireAuth(req).userId,
          clientContext(req),
        ),
      });
    });
  }

  router.get('/coupons', read, async (_req, res) => {
    res.json({ data: await c.payments.listCoupons() });
  });

  router.post('/coupons', manage, async (req, res) => {
    const body = UpsertCouponBody.parse(req.body);
    const coupon = await c.payments.upsertCoupon(
      null,
      body,
      requireAuth(req).userId,
      clientContext(req),
    );
    res.status(201).json({ data: coupon });
  });

  router.put('/coupons/:id', manage, async (req, res) => {
    const body = UpsertCouponBody.parse(req.body);
    res.json({
      data: await c.payments.upsertCoupon(
        String(req.params.id),
        body,
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });

  router.get('/purchases', read, async (req, res) => {
    const query = AdminPurchaseQuery.parse(req.query);
    res.set('Cache-Control', 'no-store').json({ data: await c.payments.listPurchases(query) });
  });

  router.get('/purchases/:id', read, async (req, res) => {
    res
      .set('Cache-Control', 'no-store')
      .json({ data: await c.payments.getPurchase(String(req.params.id)) });
  });

  router.post('/purchases/:id/refund', manage, async (req, res) => {
    const { reason } = RefundBody.parse(req.body);
    res.json({
      data: await c.payments.refund(
        String(req.params.id),
        reason,
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });

  router.post('/purchases/:id/reconcile', manage, async (req, res) => {
    res.json({
      data: await c.payments.reconcile(
        String(req.params.id),
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });

  return router;
}
