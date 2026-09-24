import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeOrder, makePlan, makePurchase, makeQuote } from '../../test/payment-fixtures';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
/** The first render loads the lazy route, which can be slow on a busy machine. */
const LOAD = { timeout: 5_000 };

const plans = [
  makePlan({
    code: 'FREE',
    name: 'Free',
    description: 'Try it out.',
    priceMinor: 0,
    credits: 1,
    validityDays: null,
    features: [],
  }),
  makePlan(),
  makePlan({ code: 'PRO', name: 'Pro', priceMinor: 99_900, credits: 8, featured: true }),
];

/** Quotes STARTER; SAVE10 takes ₹49.90 off and OLD2024 has expired. */
const quoteHandler = (body: unknown) => {
  const { couponCode } = body as { couponCode: string | null };
  if (couponCode === 'SAVE10') {
    return ok(
      makeQuote({
        discountMinor: 4_990,
        totalMinor: 44_910,
        coupon: { code: 'SAVE10', applied: true, rejection: null },
      }),
    );
  }
  if (couponCode) {
    return ok(makeQuote({ coupon: { code: couponCode, applied: false, rejection: 'EXPIRED' } }));
  }
  return ok(makeQuote());
};

describe('pricing', () => {
  it('shows every plan from the API, signed out, with Buy links for paid plans', async () => {
    const api = fakeApi({ 'GET /plans': () => ok(plans) });
    await renderRoute('/pricing', { api });

    expect(await screen.findByRole('heading', { name: 'Pricing', level: 1 }, LOAD)).toBeVisible();
    const free = await screen.findByRole('article', { name: 'Free' });
    expect(free).toHaveTextContent('Included with every account');
    expect(free).toHaveTextContent('1 interview credit');
    expect(free).toHaveTextContent('No expiry');
    expect(within(free).queryByRole('link')).not.toBeInTheDocument();

    const starter = screen.getByRole('article', { name: 'Starter' });
    expect(starter).toHaveTextContent('₹499.00');
    expect(starter).toHaveTextContent('3 interview credits');
    expect(starter).toHaveTextContent('Valid for 90 days');
    expect(starter).toHaveTextContent('Full readiness report');
    expect(within(starter).getByRole('link', { name: 'Buy Starter' })).toHaveAttribute(
      'href',
      '/app/checkout/STARTER',
    );

    const pro = screen.getByRole('article', { name: /Pro/ });
    expect(pro).toHaveTextContent('Most popular');
    expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
  });

  it('sends signed-out buyers to sign in first', async () => {
    const { router } = await renderRoute('/app/checkout/STARTER');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'), LOAD);
    expect(router.state.location.search).toBe(
      `?next=${encodeURIComponent('/app/checkout/STARTER')}`,
    );
  });
});

describe('checkout', () => {
  it('applies a coupon, shows the discount and explains a rejected coupon', async () => {
    const api = fakeApi({ ...signedIn, 'POST /payments/quote': quoteHandler });
    await renderRoute('/app/checkout/STARTER', { api });
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Checkout' }, LOAD)).toBeInTheDocument();
    expect(screen.getByTestId('total')).toHaveTextContent('₹499.00');

    const field = screen.getByLabelText('Coupon code');
    await user.type(field, 'old2024');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('This coupon has expired.')).toBeInTheDocument();
    expect(screen.getByLabelText('Coupon code')).toHaveAccessibleDescription(
      'This coupon has expired.',
    );
    expect(api.calls.at(-1)?.body).toEqual({ planCode: 'STARTER', couponCode: 'OLD2024' });
    expect(screen.getByTestId('total')).toHaveTextContent('₹499.00');

    await user.clear(screen.getByLabelText('Coupon code'));
    await user.type(screen.getByLabelText('Coupon code'), 'SAVE10');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Coupon SAVE10 applied.')).toBeInTheDocument();
    expect(screen.getByText('Discount (SAVE10)')).toBeInTheDocument();
    expect(screen.getByTestId('total')).toHaveTextContent('₹449.10');
    expect(screen.getByRole('button', { name: 'Pay ₹449.10' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByTestId('total')).toHaveTextContent('₹499.00'));
  });

  it('runs the mock checkout: mock/checkout, then verify, then the status page', async () => {
    let status: 'CREATED' | 'PAID' = 'CREATED';
    const api = fakeApi({
      ...signedIn,
      'POST /payments/quote': quoteHandler,
      'POST /payments/orders': () => ({ status: 201, body: { data: makeOrder() } }),
      'POST /payments/mock/checkout': () =>
        ok({
          checkout: {
            razorpay_order_id: 'order_1',
            razorpay_payment_id: 'pay_1',
            razorpay_signature: 'a'.repeat(64),
          },
          purchase: makePurchase(),
        }),
      'POST /payments/verify': () => {
        status = 'PAID';
        return ok(makePurchase({ status: 'PAID', creditsIssuedAt: '2026-09-20T10:01:00.000Z' }));
      },
      'GET /payments/purchases/p1': () => ok(makePurchase({ status })),
      'GET /credits/balance': () => ok({ available: 4, reserved: 0, lots: [] }),
    });
    const { router } = await renderRoute('/app/checkout/STARTER', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Pay ₹499.00' }, LOAD));
    expect(await screen.findByText('Test mode')).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /payments/orders')?.body).toEqual({
      planCode: 'STARTER',
      couponCode: null,
    });

    await user.click(screen.getByRole('button', { name: 'Simulate successful payment' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/payments/p1'));
    const keys = api.calls.map((c) => c.key);
    expect(keys.indexOf('POST /payments/mock/checkout')).toBeLessThan(
      keys.indexOf('POST /payments/verify'),
    );
    expect(api.calls.find((c) => c.key === 'POST /payments/mock/checkout')?.body).toEqual({
      purchaseId: 'p1',
      outcome: 'success',
    });
    expect(api.calls.find((c) => c.key === 'POST /payments/verify')?.body).toEqual({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'a'.repeat(64),
    });
    expect(
      await screen.findByRole('heading', { name: 'Payment successful' }, LOAD),
    ).toBeInTheDocument();
  });

  it('sends a failed mock payment to the status page without verifying', async () => {
    const api = fakeApi({
      ...signedIn,
      'POST /payments/quote': quoteHandler,
      'POST /payments/orders': () => ({ status: 201, body: { data: makeOrder() } }),
      'POST /payments/mock/checkout': () =>
        ok({ checkout: null, purchase: makePurchase({ status: 'FAILED' }) }),
      'GET /payments/purchases/p1': () => ok(makePurchase({ status: 'FAILED' })),
    });
    const { router } = await renderRoute('/app/checkout/STARTER', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Pay ₹499.00' }, LOAD));
    await user.click(await screen.findByRole('button', { name: 'Simulate failed payment' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/payments/p1'));
    expect(await screen.findByRole('heading', { name: 'Payment failed' }, LOAD)).toBeVisible();
    expect(api.calls.some((c) => c.key === 'POST /payments/verify')).toBe(false);
  });

  it('goes straight to the status page when a coupon makes the order free', async () => {
    const api = fakeApi({
      ...signedIn,
      'POST /payments/quote': quoteHandler,
      'POST /payments/orders': () => ({
        status: 201,
        body: { data: makeOrder({ status: 'PAID', totalMinor: 0, provider: null }) },
      }),
      'GET /payments/purchases/p1': () => ok(makePurchase({ status: 'PAID', totalMinor: 0 })),
    });
    const { router } = await renderRoute('/app/checkout/STARTER', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Pay ₹499.00' }, LOAD));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/payments/p1'));
  });

  it('explains when payments are unavailable and lets the candidate try again', async () => {
    const api = fakeApi({
      ...signedIn,
      'POST /payments/quote': quoteHandler,
      'POST /payments/orders': () => fail(503, 'PROVIDER_UNAVAILABLE'),
    });
    await renderRoute('/app/checkout/STARTER', { api });
    const user = userEvent.setup();

    const pay = await screen.findByRole('button', { name: 'Pay ₹499.00' }, LOAD);
    await user.click(pay);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Payments are temporarily unavailable',
    );
    expect(pay).toBeEnabled();
  });

  it('shows the coupon rejection when the order refuses the coupon', async () => {
    let expired = false;
    const api = fakeApi({
      ...signedIn,
      'POST /payments/quote': (body) =>
        expired
          ? ok(makeQuote({ coupon: { code: 'SAVE10', applied: false, rejection: 'USED_UP' } }))
          : quoteHandler(body),
      'POST /payments/orders': () => {
        expired = true;
        return fail(400, 'VALIDATION_FAILED', { rejection: 'USED_UP' });
      },
    });
    await renderRoute('/app/checkout/STARTER', { api });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Coupon code', {}, LOAD), 'SAVE10');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(await screen.findByRole('button', { name: 'Pay ₹449.10' }));
    expect(await screen.findByText('This coupon has reached its usage limit.')).toBeInTheDocument();
  });
});

describe('payment status', () => {
  it('confirms a paid purchase with the credits added and next steps', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /payments/purchases/p1': () => ok(makePurchase({ status: 'PAID' })),
    });
    await renderRoute('/app/payments/p1', { api });

    expect(await screen.findByRole('heading', { name: 'Payment successful' }, LOAD)).toBeVisible();
    expect(
      screen.getByText(/3 interview credits have been added to your account\. Valid for 90 days/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start an interview' })).toHaveAttribute(
      'href',
      '/app/new',
    );
    expect(screen.getByRole('link', { name: 'View purchase history' })).toHaveAttribute(
      'href',
      '/app/purchases',
    );
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('offers a retry for a failed payment', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /payments/purchases/p1': () => ok(makePurchase({ status: 'FAILED' })),
    });
    await renderRoute('/app/payments/p1', { api });

    expect(await screen.findByRole('heading', { name: 'Payment failed' }, LOAD)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/app/checkout/STARTER',
    );
  });

  it('keeps checking while the payment is being confirmed', async () => {
    let reads = 0;
    const api = fakeApi({
      ...signedIn,
      'GET /payments/purchases/p1': () => {
        reads += 1;
        return ok(makePurchase({ status: reads > 1 ? 'PAID' : 'CREATED' }));
      },
    });
    await renderRoute('/app/payments/p1', { api });

    expect(
      await screen.findByRole('heading', { name: 'Confirming your payment' }, LOAD),
    ).toBeVisible();
    expect(
      await screen.findByRole('heading', { name: 'Payment successful' }, { timeout: 5_000 }),
    ).toBeVisible();
  });

  it('explains an expired order', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /payments/purchases/p1': () => ok(makePurchase({ status: 'EXPIRED' })),
    });
    await renderRoute('/app/payments/p1', { api });
    expect(
      await screen.findByRole('heading', { name: 'This order has expired' }, LOAD),
    ).toBeVisible();
  });
});

describe('purchases', () => {
  it('lists purchases with status and a link to each', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /payments/purchases': () =>
        ok([
          makePurchase({ id: 'p2', status: 'PAID' }),
          makePurchase({ id: 'p1', status: 'FAILED' }),
        ]),
    });
    await renderRoute('/app/purchases', { api });

    const table = await screen.findByRole('table', { name: 'Your purchases' }, LOAD);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Starter');
    expect(rows[0]).toHaveTextContent('₹499.00');
    expect(rows[0]).toHaveTextContent('Paid');
    expect(rows[1]).toHaveTextContent('Failed');
    expect(within(rows[0]!).getByRole('link', { name: /View Starter purchase/ })).toHaveAttribute(
      'href',
      '/app/payments/p2',
    );
  });

  it('points to pricing when there are no purchases', async () => {
    const api = fakeApi({ ...signedIn, 'GET /payments/purchases': () => ok([]) });
    await renderRoute('/app/purchases', { api });
    expect(
      await screen.findByRole('heading', { name: 'No purchases yet' }, LOAD),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/pricing');
  });
});
