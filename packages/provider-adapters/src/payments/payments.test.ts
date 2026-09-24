import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMockGateway } from './mock.js';
import { createRazorpayGateway, hmacHex, safeEqualHex } from './razorpay.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function gateway(fetchImpl = vi.fn()) {
  return {
    fetchImpl,
    gw: createRazorpayGateway({
      keyId: 'rzp_test_key',
      keySecret: 'secret123',
      webhookSecret: 'whsec',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  };
}

describe('signatures', () => {
  it('verifies Checkout signatures as HMAC-SHA256(order|payment) with the key secret', () => {
    const { gw } = gateway();
    const sig = createHmac('sha256', 'secret123').update('order_1|pay_1').digest('hex');
    expect(gw.verifyPaymentSignature('order_1', 'pay_1', sig)).toBe(true);
    expect(gw.verifyPaymentSignature('order_1', 'pay_2', sig)).toBe(false);
    expect(gw.verifyPaymentSignature('order_1', 'pay_1', sig.toUpperCase())).toBe(true);
    expect(gw.verifyPaymentSignature('order_1', 'pay_1', 'not-hex')).toBe(false);
    expect(gw.verifyPaymentSignature('order_1', 'pay_1', sig.slice(0, 10))).toBe(false);
  });

  it('compares hex safely', () => {
    expect(safeEqualHex('abcd', 'ABCD')).toBe(true);
    expect(safeEqualHex('abcd', '')).toBe(false);
    expect(safeEqualHex('abcd', 'abcdef')).toBe(false);
  });
});

describe('webhooks', () => {
  const body = (event: string, payload: object) => Buffer.from(JSON.stringify({ event, payload }));

  it('accepts only bodies signed with the webhook secret, byte for byte', () => {
    const { gw } = gateway();
    const raw = body('payment.captured', {
      payment: {
        entity: {
          id: 'pay_1',
          order_id: 'order_1',
          amount: 19900,
          currency: 'INR',
          status: 'captured',
        },
      },
    });
    const sig = hmacHex('whsec', raw);
    expect(gw.parseWebhook(raw, sig, 'evt_1')).toEqual({
      kind: 'payment.captured',
      eventId: 'evt_1',
      payment: {
        id: 'pay_1',
        orderId: 'order_1',
        amountMinor: 19900,
        currency: 'INR',
        status: 'captured',
      },
    });
    expect(gw.parseWebhook(raw, undefined, 'evt_1')).toBeNull();
    expect(gw.parseWebhook(raw, hmacHex('wrong', raw), 'evt_1')).toBeNull();
    // Re-serialising the JSON (e.g. whitespace) breaks the signature: the raw body must be used.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2));
    expect(gw.parseWebhook(reserialised, sig, 'evt_1')).toBeNull();
  });

  it('parses refunds, ignores other events and derives an id when the header is missing', () => {
    const { gw } = gateway();
    const refund = body('refund.processed', {
      refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 19900, status: 'processed' } },
    });
    expect(gw.parseWebhook(refund, hmacHex('whsec', refund), 'evt_2')).toMatchObject({
      kind: 'refund.processed',
      refund: { id: 'rfnd_1', paymentId: 'pay_1', amountMinor: 19900 },
    });
    const other = body('payment.authorized', {});
    const parsed = gw.parseWebhook(other, hmacHex('whsec', other), undefined);
    expect(parsed).toMatchObject({ kind: 'ignored', type: 'payment.authorized' });
    expect(parsed!.eventId).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('REST calls', () => {
  it('creates orders with basic auth and maps payments and refunds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, { id: 'order_1', amount: 19900, currency: 'INR', status: 'created' }),
      )
      .mockResolvedValueOnce(
        json(200, {
          items: [
            {
              id: 'pay_1',
              order_id: 'order_1',
              amount: 19900,
              currency: 'INR',
              status: 'captured',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json(200, { id: 'rfnd_1', payment_id: 'pay_1', amount: 19900, status: 'pending' }),
      );
    const { gw } = gateway(fetchImpl);
    expect(
      await gw.createOrder({ amountMinor: 19900, currency: 'INR', receipt: 'p'.repeat(60) }),
    ).toEqual({
      id: 'order_1',
      amountMinor: 19900,
      currency: 'INR',
      status: 'created',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('rzp_test_key:secret123').toString('base64')}`,
    );
    expect(JSON.parse(init.body).receipt).toHaveLength(40);
    expect(await gw.fetchOrderPayments('order_1')).toEqual([
      { id: 'pay_1', orderId: 'order_1', amountMinor: 19900, currency: 'INR', status: 'captured' },
    ]);
    expect(await gw.refund('pay_1', 19900)).toMatchObject({ id: 'rfnd_1', status: 'pending' });
  });

  it('reports failures without echoing provider messages', async () => {
    const { gw } = gateway(
      vi
        .fn()
        .mockResolvedValue(
          json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'secret stuff' } }),
        ),
    );
    const err = await gw
      .createOrder({ amountMinor: 1, currency: 'INR', receipt: 'x' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false });
    expect(String((err as Error).message)).toContain('BAD_REQUEST_ERROR');
    expect(String((err as Error).message)).not.toContain('secret stuff');
    const { gw: down } = gateway(vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(down.fetchPayment('pay_1')).rejects.toMatchObject({ retryable: true });
  });
});

describe('mock gateway', () => {
  it('produces Checkout results and webhooks the same way Razorpay does', async () => {
    const mock = createMockGateway();
    const order = await mock.gateway.createOrder({
      amountMinor: 49900,
      currency: 'INR',
      receipt: 'p1',
    });
    const { checkout, payment } = mock.pay(order.id);
    expect(
      mock.gateway.verifyPaymentSignature(
        checkout.razorpay_order_id,
        checkout.razorpay_payment_id,
        checkout.razorpay_signature,
      ),
    ).toBe(true);
    expect(await mock.gateway.fetchOrderPayments(order.id)).toEqual([payment]);
    const hook = mock.webhook('payment.captured', { payment });
    expect(mock.gateway.parseWebhook(hook.body, hook.signature, hook.eventId)).toMatchObject({
      kind: 'payment.captured',
      payment,
    });
  });
});
