import type { AdminMeResponse, AdminRole, Permission } from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fail, fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';
import { formatMoney, paiseToRupees, rupeesToPaise } from './format';
import { coupon, creditAccount, plan, purchase, refundPreview } from './test-fixtures';

const REASON = 'Reason (recorded in the audit log)';

function adminMe(roles: AdminRole[]): AdminMeResponse {
  return {
    ...makeUser({ id: 'admin-1', email: 'root@codebegun.com', adminRoles: roles }),
    permissions: [...permissionsFor(roles)] as Permission[],
  };
}

async function renderAt(
  path: string,
  roles: AdminRole[],
  handlers: Parameters<typeof fakeApi>[0] = {},
) {
  const api = fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(adminMe(roles)),
    ...handlers,
  });
  const i18n = await initI18n();
  const manager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'admin',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider manager={manager} loadUser={loadAdminUser}>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { api, router };
}

const bodyOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.find((c) => c.key === key)!.body;

/** fakeApi keys ignore the query string, so list requests are checked by URL. */
const purchaseQueries = (api: ReturnType<typeof fakeApi>) =>
  (api.fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls
    .map(([url]) => new URL(url))
    .filter((u) => u.pathname.endsWith('/admin/purchases'))
    .map((u) => Object.fromEntries(u.searchParams));

describe('money helpers', () => {
  it('formats paise as rupees and parses rupee input to integer paise', () => {
    expect(formatMoney(149_950, 'INR')).toBe('₹1,499.50');
    expect(formatMoney(10_000_000, 'INR')).toBe('₹1,00,000.00');
    expect(rupeesToPaise('1,499.5')).toBe(149_950);
    expect(rupeesToPaise('499')).toBe(49_900);
    expect(rupeesToPaise('0.05')).toBe(5);
    expect(rupeesToPaise('1.234')).toBeNaN();
    expect(rupeesToPaise('abc')).toBeNaN();
    expect(paiseToRupees(149_950)).toBe('1499.50');
    expect(paiseToRupees(49_900)).toBe('499');
  });
});

describe('payments navigation', () => {
  it('shows the Payments group to support admins', async () => {
    await renderAt('/', ['SUPPORT_ADMIN']);
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const group = within(nav).getByRole('list', { name: 'Payments' });
    for (const name of ['Purchases', 'Plans', 'Coupons']) {
      expect(within(group).getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('hides payments from admins without payments.read', async () => {
    await renderAt('/purchases', ['CONTENT_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).queryByRole('link', { name: 'Purchases' })).not.toBeInTheDocument();
  });
});

describe('purchases', () => {
  it('lists purchases and filters by status and search', async () => {
    const { api, router } = await renderAt('/purchases', ['SUPPORT_ADMIN'], {
      'GET /admin/purchases': () =>
        ok([
          purchase(),
          purchase({ id: 'pur2', status: 'CREATED', userEmail: null, couponCode: null }),
        ]),
    });
    const table = await screen.findByRole('table');
    const paid = within(table).getByRole('row', { name: /pur1/ });
    expect(within(paid).getByText('asha@example.com')).toBeInTheDocument();
    expect(within(paid).getByText('₹799.20')).toBeInTheDocument();
    expect(within(paid).getByText('Paid')).toBeInTheDocument();
    const pending = within(table).getByRole('row', { name: /pur2/ });
    expect(within(pending).getByText('user-7')).toBeInTheDocument();
    expect(within(pending).getByText('Awaiting payment')).toBeInTheDocument();
    expect(purchaseQueries(api)[0]).toEqual({ limit: '100' });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Status'), 'REFUNDED');
    await user.type(screen.getByLabelText('Search'), ' pay_XYZ ');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('table');
    await expect.poll(() => router.state.location.search).toBe('?status=REFUNDED&q=pay_XYZ');
    await expect
      .poll(() => purchaseQueries(api).at(-1))
      .toEqual({
        limit: '100',
        status: 'REFUNDED',
        q: 'pay_XYZ',
      });

    await user.click(screen.getByRole('link', { name: 'Open purchase pur1' }));
    await expect.poll(() => router.state.location.pathname).toBe('/purchases/pur1');
  });

  it('shows purchase details with the payment history timeline', async () => {
    await renderAt('/purchases/pur1', ['FINANCE_ADMIN'], {
      'GET /admin/purchases/pur1': () => ok(purchase()),
    });
    expect(await screen.findByText('order_ABC')).toBeInTheDocument();
    expect(screen.getByText('pay_XYZ')).toBeInTheDocument();
    expect(screen.getByText('₹999.00')).toBeInTheDocument();
    expect(screen.getByText('₹199.80')).toBeInTheDocument();
    expect(screen.getByText('LAUNCH20')).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Payment history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(within(history).getByText(/via webhook/)).toBeInTheDocument();
  });

  it('requires a reason and confirmation before refunding in full', async () => {
    const refunded = purchase({
      status: 'REFUNDED',
      refundedMinor: 79_920,
      payment: { ...purchase().payment!, status: 'REFUNDED' },
    });
    const { api } = await renderAt('/purchases/pur1', ['FINANCE_ADMIN'], {
      'GET /admin/purchases/pur1': () => ok(purchase()),
      'GET /admin/purchases/pur1/refund-preview': () => ok(refundPreview()),
      'POST /admin/purchases/pur1/refund': () =>
        ok({ purchase: refunded, refundStatus: 'processed', creditsWithdrawn: 7 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    expect(
      await screen.findByText('10 granted · 0 used · 10 unused · 0 expired · 0 withdrawn'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Refunding everything left withdraws every unused credit (10).'),
    ).toBeInTheDocument();
    // Nothing used: no extra confirmation for used credits.
    expect(
      screen.queryByLabelText('I have checked the credits already used and want to refund anyway.'),
    ).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Refund ₹799.20' });
    await user.type(screen.getByLabelText(REASON), 'Customer asked within 7 days');
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByLabelText(
        'I understand that the withdrawn credits are removed and this cannot be undone.',
      ),
    );
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(
      await screen.findByText('Refund processed. 7 credits were withdrawn.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/purchases/pur1/refund')).toEqual({
      reason: 'Customer asked within 7 days',
      amountMinor: 79_920,
      acknowledgeUsedCredits: false,
    });
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
  });

  it('shows used credits, requires confirming them and refunds part of the amount', async () => {
    const { api } = await renderAt('/purchases/pur1', ['FINANCE_ADMIN'], {
      'GET /admin/purchases/pur1': () => ok(purchase()),
      'GET /admin/purchases/pur1/refund-preview': () =>
        ok(
          refundPreview({
            creditsUsed: 4,
            creditsUnused: 6,
            suggestedMinor: 47_952,
          }),
        ),
      'POST /admin/purchases/pur1/refund': () =>
        ok({
          purchase: purchase({ refundedMinor: 40_000 }),
          refundStatus: 'processed',
          creditsWithdrawn: 5,
        }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    expect(
      await screen.findByText(/The candidate has already used 4 credits from this purchase/),
    ).toBeInTheDocument();
    // The prorated suggestion is the default amount.
    const amount = screen.getByLabelText('Amount to refund (rupees)');
    expect(amount).toHaveValue('479.52');
    expect(screen.getByLabelText('Unused credits to withdraw')).toHaveValue('6');

    await user.clear(amount);
    await user.type(amount, '900');
    await user.type(screen.getByLabelText(REASON), 'Partial goodwill refund');
    await user.click(
      screen.getByLabelText(
        'I understand that the withdrawn credits are removed and this cannot be undone.',
      ),
    );
    // Used credits need their own confirmation before the button works.
    const submit = screen.getByRole('button', { name: /^Refund ₹/ });
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByLabelText('I have checked the credits already used and want to refund anyway.'),
    );
    await user.click(submit);
    expect(
      screen.getByText('Enter an amount of at most ₹799.20 (at most 2 decimals).'),
    ).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'POST /admin/purchases/pur1/refund')).toBe(false);

    await user.clear(amount);
    await user.type(amount, '400');
    const withdraw = screen.getByLabelText('Unused credits to withdraw');
    await user.clear(withdraw);
    await user.type(withdraw, '5');
    await user.click(screen.getByRole('button', { name: 'Refund ₹400.00' }));
    expect(
      await screen.findByText('Refund processed. 5 credits were withdrawn.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/purchases/pur1/refund')).toEqual({
      reason: 'Partial goodwill refund',
      amountMinor: 40_000,
      withdrawCredits: 5,
      acknowledgeUsedCredits: true,
    });
  });

  it('flags a failed refund and lists the refunds', async () => {
    const failed = purchase({
      refundFailed: true,
      payment: {
        ...purchase().payment!,
        refunds: [
          {
            id: 'rfnd_1',
            amountMinor: 79_920,
            status: 'failed',
            creditsToWithdraw: 10,
            creditsWithdrawn: 0,
            reason: 'Customer request',
            requestedAt: new Date().toISOString(),
            processedAt: null,
          },
        ],
      },
    });
    await renderAt('/purchases/pur1', ['SUPPORT_ADMIN'], {
      'GET /admin/purchases/pur1': () => ok(failed),
    });
    expect(
      await screen.findByText(/reported a refund of this purchase as failed/),
    ).toBeInTheDocument();
    const refunds = screen.getByRole('list', { name: 'Refunds' });
    expect(within(refunds).getByText('Failed')).toBeInTheDocument();
    expect(within(refunds).getByText('Customer request')).toBeInTheDocument();
  });

  it('marks failed refunds in the purchases list and links users to their credits', async () => {
    const { router } = await renderAt('/purchases', ['SUPPORT_ADMIN'], {
      'GET /admin/purchases': () => ok([purchase({ refundFailed: true, refundedMinor: 10_000 })]),
    });
    const row = within(await screen.findByRole('table')).getByRole('row', { name: /pur1/ });
    expect(within(row).getByText('Refund failed')).toBeInTheDocument();
    expect(within(row).getByText('₹100.00 refunded')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(row).getByRole('link', { name: 'Credits of asha@example.com' }));
    await expect.poll(() => router.state.location.search).toBe('?user=user-7');
  });

  it('downloads the receipt of a paid purchase', async () => {
    await renderAt('/purchases/pur1', ['SUPPORT_ADMIN'], {
      'GET /admin/purchases/pur1': () => ok(purchase()),
    });
    expect(await screen.findByRole('button', { name: 'Download receipt' })).toBeInTheDocument();
    expect(screen.getByText('CPI/26-27/000042')).toBeInTheDocument();
  });

  it('explains a refund the provider cannot process right now', async () => {
    await renderAt('/purchases/pur1', ['FINANCE_ADMIN'], {
      'GET /admin/purchases/pur1': () => ok(purchase()),
      'GET /admin/purchases/pur1/refund-preview': () => ok(refundPreview()),
      'POST /admin/purchases/pur1/refund': () => fail(503, 'PROVIDER_UNAVAILABLE'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    await user.type(await screen.findByLabelText(REASON), 'Duplicate payment');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Refund ₹799.20' }));
    expect(
      await screen.findByText(
        'The payment provider is not responding. Try again in a few minutes.',
      ),
    ).toBeInTheDocument();
  });

  it('reconciles a purchase and shows the outcome', async () => {
    const { api } = await renderAt('/purchases/pur1', ['SUPER_ADMIN'], {
      'GET /admin/purchases/pur1': () =>
        ok(purchase({ status: 'CREATED', creditsIssuedAt: null, payment: null })),
      'POST /admin/purchases/pur1/reconcile': () => ok({ outcome: 'PAID', purchase: purchase() }),
    });
    const user = userEvent.setup();
    expect(
      await screen.findByText(
        'Only paid purchases with a captured payment and an amount left to refund can be refunded.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconcile with provider' }));
    expect(
      await screen.findByText('Reconciled: the payment was captured and credits were issued.'),
    ).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'POST /admin/purchases/pur1/reconcile')).toBe(true);
    expect(await screen.findByText('order_ABC')).toBeInTheDocument();
  });

  it('hides refund and reconcile from support admins', async () => {
    await renderAt('/purchases/pur1', ['SUPPORT_ADMIN'], {
      'GET /admin/purchases/pur1': () => ok(purchase()),
    });
    expect(await screen.findByText('order_ABC')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Reconcile with provider' }),
    ).not.toBeInTheDocument();
  });
});

describe('credits', () => {
  it('looks up a candidate and grants credits with a reason', async () => {
    const account = creditAccount();
    const { api } = await renderAt('/credits?user=asha@example.com', ['FINANCE_ADMIN'], {
      'GET /admin/credits/account': () => ok(account),
      'POST /admin/credits/adjustments': () =>
        ok(creditAccount({ balance: { ...account.balance, available: 5 } })),
    });
    const region = await screen.findByRole('region', { name: 'Account' });
    expect(within(region).getByText('asha@example.com')).toBeInTheDocument();
    expect(within(region).getByText('Sprint plan')).toBeInTheDocument();
    const user = userEvent.setup();
    const count = screen.getByLabelText('Credits');
    await user.clear(count);
    await user.type(count, '2');
    await user.type(screen.getByLabelText('Expires after (days, optional)'), '30');
    await user.type(screen.getByLabelText(REASON), 'Interview failed on our side');
    await user.click(screen.getByRole('button', { name: 'Grant 2 credits' }));
    expect(await screen.findByText('Granted 2 credits.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/credits/adjustments')).toEqual({
      userId: account.userId,
      delta: 2,
      reason: 'Interview failed on our side',
      expiresInDays: 30,
    });
    expect(within(region).getByText('5')).toBeInTheDocument();
  });

  it('deducts credits and explains when there are not enough', async () => {
    const { api } = await renderAt('/credits?user=user-7', ['SUPER_ADMIN'], {
      'GET /admin/credits/account': () => ok(creditAccount()),
      'POST /admin/credits/adjustments': () => fail(409, 'INSUFFICIENT_CREDITS'),
    });
    await screen.findByRole('region', { name: 'Account' });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Deduct credits'));
    const count = screen.getByLabelText('Credits');
    await user.clear(count);
    await user.type(count, '0');
    await user.type(screen.getByLabelText(REASON), 'Duplicate grant');
    await user.click(screen.getByRole('button', { name: 'Deduct 0 credits' }));
    expect(screen.getByText('Enter a whole number from 1 to 500.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'POST /admin/credits/adjustments')).toBe(false);
    await user.clear(count);
    await user.type(count, '9');
    await user.click(screen.getByRole('button', { name: 'Deduct 9 credits' }));
    await screen.findByRole('alert');
    expect(bodyOf(api, 'POST /admin/credits/adjustments')).toMatchObject({
      delta: -9,
      expiresInDays: null,
    });
  });

  it('is read-only for support admins and reachable from purchases', async () => {
    const { router } = await renderAt('/purchases', ['SUPPORT_ADMIN'], {
      'GET /admin/purchases': () => ok([]),
      'GET /admin/credits/account': () => ok(creditAccount()),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Adjust credits' }));
    await expect.poll(() => router.state.location.pathname).toBe('/credits');
    await user.type(await screen.findByLabelText('Email or user id'), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('region', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('Only finance admins can adjust credits.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Grant/ })).not.toBeInTheDocument();
  });
});

describe('plans', () => {
  const plans = () => [
    plan(),
    plan({ id: 'plan-pro-1', version: 1, active: false, priceMinor: 79_900, featured: false }),
    plan({
      id: 'plan-free-1',
      code: 'FREE',
      version: 1,
      name: 'Free',
      priceMinor: 0,
      credits: 1,
      validityDays: null,
      displayOrder: 0,
      featured: false,
    }),
  ];

  it('groups versions by code and highlights the one on sale', async () => {
    await renderAt('/plans', ['FINANCE_ADMIN'], { 'GET /admin/plans': () => ok(plans()) });
    const pro = await screen.findByRole('region', { name: 'PRO' });
    expect(
      within(pro).getByText('On sale: Pro pack (v2) · ₹999.00 · 10 credits'),
    ).toBeInTheDocument();
    const v2 = within(pro).getByRole('row', { name: /^v2/ });
    expect(v2).toHaveClass('table-success');
    expect(within(v2).getByText('90 days')).toBeInTheDocument();
    const v1 = within(pro).getByRole('row', { name: /^v1/ });
    expect(within(v1).getByText('₹799.00')).toBeInTheDocument();
    expect(within(v1).getByText('Inactive')).toBeInTheDocument();
    const free = screen.getByRole('region', { name: 'FREE' });
    expect(within(free).getAllByText('Free').length).toBeGreaterThan(0);
    expect(within(free).getByText('No expiry')).toBeInTheDocument();
  });

  it('creates a new version prefilled from the selected one and posts paise', async () => {
    const { api } = await renderAt('/plans', ['FINANCE_ADMIN'], {
      'GET /admin/plans': () => ok(plans()),
      'POST /admin/plans': () => ({
        status: 201,
        body: { data: plan({ id: 'plan-pro-3', version: 3, active: false }) },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New version from PRO v1' }));
    expect(screen.getByLabelText('Plan code')).toHaveValue('PRO');
    expect(screen.getByLabelText('Plan code')).toHaveAttribute('readonly');
    const price = screen.getByLabelText('Price (rupees)');
    expect(price).toHaveValue('799');

    await user.clear(price);
    await user.type(price, '1,499.5');
    await user.clear(screen.getByLabelText('Credits'));
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(screen.getByLabelText('Credits')).toHaveAccessibleDescription(
      'Enter a whole number of credits from 1 to 500.',
    );
    expect(screen.getByLabelText(REASON)).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls.some((c) => c.key === 'POST /admin/plans')).toBe(false);

    await user.type(screen.getByLabelText('Credits'), '15');
    await user.clear(screen.getByLabelText('Validity (days)'));
    await user.type(screen.getByLabelText(REASON), 'Festive pricing');
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(
      await screen.findByText('Created PRO v3 (inactive). Activate it to put it on sale.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/plans')).toEqual({
      code: 'PRO',
      content: {
        name: 'Pro pack',
        description: 'Ten interviews with full reports.',
        priceMinor: 149_950,
        currency: 'INR',
        credits: 15,
        validityDays: null,
        features: ['Full reports', 'All roles'],
        displayOrder: 20,
        featured: false,
      },
      reason: 'Festive pricing',
    });
  });

  it('activates a version with a reason', async () => {
    const { api } = await renderAt('/plans', ['SUPER_ADMIN'], {
      'GET /admin/plans': () => ok(plans()),
      'POST /admin/plans/plan-pro-1/activate': () => ok(plan({ id: 'plan-pro-1', version: 1 })),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Activate PRO v1' }));
    expect(
      screen.getByText(
        'v1 goes on sale for PRO, replacing the version currently on sale. Existing purchases are not affected.',
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(REASON), 'Roll back price');
    await user.click(screen.getByRole('button', { name: 'Activate PRO v1' }));
    expect(await screen.findByText('PRO v1 is now on sale.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/plans/plan-pro-1/activate')).toEqual({
      reason: 'Roll back price',
    });
  });

  it('hides plan management from support admins', async () => {
    await renderAt('/plans', ['SUPPORT_ADMIN'], { 'GET /admin/plans': () => ok(plans()) });
    expect(await screen.findByRole('region', { name: 'PRO' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New plan' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New version from PRO v2' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate PRO v2' })).not.toBeInTheDocument();
  });
});

describe('coupons', () => {
  it('lists coupons with their usage', async () => {
    await renderAt('/coupons', ['SUPPORT_ADMIN'], {
      'GET /admin/coupons': () =>
        ok([
          coupon(),
          coupon({
            id: 'cp2',
            code: 'FLAT100',
            type: 'FIXED',
            value: 10_000,
            maxUses: null,
            usedCount: 3,
            planCodes: ['PRO'],
            active: false,
          }),
        ]),
    });
    const table = await screen.findByRole('table');
    const launch = within(table).getByRole('row', { name: /LAUNCH20/ });
    expect(within(launch).getByText('20%')).toBeInTheDocument();
    expect(within(launch).getByText('12 / 100')).toBeInTheDocument();
    expect(within(launch).getByText('All plans')).toBeInTheDocument();
    const flat = within(table).getByRole('row', { name: /FLAT100/ });
    expect(within(flat).getByText('₹100.00')).toBeInTheDocument();
    expect(within(flat).getByText('3 / unlimited')).toBeInTheDocument();
    expect(within(flat).getByText('Inactive')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New coupon' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit LAUNCH20' })).not.toBeInTheDocument();
  });

  it('creates a fixed coupon in paise and explains a duplicate code', async () => {
    const { api } = await renderAt('/coupons', ['FINANCE_ADMIN'], {
      'GET /admin/coupons': () => ok([coupon()]),
      'GET /admin/plans': () => ok([plan(), plan({ id: 'b1', code: 'BASIC', version: 1 })]),
      'POST /admin/coupons': () => fail(409, 'CONFLICT'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New coupon' }));
    await user.type(screen.getByLabelText('Code'), 'flat-50');
    await user.selectOptions(screen.getByLabelText('Type'), 'FIXED');
    await user.type(screen.getByLabelText('Discount (rupees)'), '50.5');
    await user.clear(screen.getByLabelText('Uses per candidate'));
    await user.type(screen.getByLabelText('Uses per candidate'), '2');
    await user.click(await screen.findByLabelText('BASIC'));
    await user.click(screen.getByRole('button', { name: 'Create coupon' }));
    expect(await screen.findByText('A coupon with this code already exists.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/coupons')).toEqual({
      code: 'FLAT-50',
      type: 'FIXED',
      value: 5_050,
      validFrom: null,
      validTo: null,
      maxUses: null,
      perUserLimit: 2,
      planCodes: ['BASIC'],
      active: true,
    });
  });

  it('rejects an out-of-range percent before calling the API', async () => {
    const { api } = await renderAt('/coupons', ['FINANCE_ADMIN'], {
      'GET /admin/coupons': () => ok([]),
      'GET /admin/plans': () => ok([]),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New coupon' }));
    await user.type(screen.getByLabelText('Code'), 'BIG');
    await user.type(screen.getByLabelText('Discount (%)'), '150');
    await user.click(screen.getByRole('button', { name: 'Create coupon' }));
    expect(screen.getByLabelText('Discount (%)')).toHaveAccessibleDescription(
      'Enter a whole percent from 1 to 100.',
    );
    expect(api.calls.some((c) => c.key === 'POST /admin/coupons')).toBe(false);
  });

  it('edits a coupon without changing its code', async () => {
    const { api } = await renderAt('/coupons', ['FINANCE_ADMIN'], {
      'GET /admin/coupons': () => ok([coupon()]),
      'GET /admin/plans': () => ok([plan()]),
      'PUT /admin/coupons/cp1': (body) => ok({ ...coupon(), ...(body as object) }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit LAUNCH20' }));
    expect(screen.getByLabelText('Code')).toHaveAttribute('readonly');
    const value = screen.getByLabelText('Discount (%)');
    await user.clear(value);
    await user.type(value, '25');
    await user.click(screen.getByRole('button', { name: 'Save coupon' }));
    expect(await screen.findByText('Saved coupon LAUNCH20.')).toBeInTheDocument();
    expect(bodyOf(api, 'PUT /admin/coupons/cp1')).toMatchObject({
      code: 'LAUNCH20',
      type: 'PERCENT',
      value: 25,
      maxUses: 100,
    });
  });
});
