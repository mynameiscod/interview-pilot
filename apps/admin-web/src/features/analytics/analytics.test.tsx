import type {
  AdminMeResponse,
  AdminRole,
  CostReport,
  Dashboard,
  Permission,
} from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';
import { presetRange } from './format';

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

const queriesTo = (api: ReturnType<typeof fakeApi>, suffix: string) =>
  (api.fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls
    .map(([url]) => new URL(url))
    .filter((u) => u.pathname.endsWith(suffix))
    .map((u) => Object.fromEntries(u.searchParams));

const dashboard = (overrides: Partial<Dashboard> = {}): Dashboard => ({
  range: { from: '2026-08-26', to: '2026-09-24', days: 30 },
  kpis: {
    registrations: 120,
    activeUsers: 80,
    interviewsStarted: 50,
    interviewsCompleted: 40,
    interviewsFailed: 1,
    completionRate: 0.8,
    failureRate: 0.02,
    freeToPaidRate: 0.04,
    revenueMinor: 1_234_500,
    refundsMinor: 10_000,
    aiCostMinor: 250_050,
    gatewayFeesMinor: 24_690,
    grossMargin: 0.75,
    activeSessions: 3,
  },
  targets: { completionRate: 0.7, freeToPaidRate: 0.05, grossMargin: 0.6, maxFailureRate: 0.03 },
  series: [
    {
      day: '2026-09-23',
      registrations: 5,
      interviewsStarted: 3,
      interviewsCompleted: 2,
      revenueMinor: 49_900,
      aiCostMinor: 12_000,
    },
    {
      day: '2026-09-24',
      registrations: 7,
      interviewsStarted: 4,
      interviewsCompleted: 4,
      revenueMinor: 99_800,
      aiCostMinor: 15_000,
    },
  ],
  funnel: [
    { step: 'registered', users: 120 },
    { step: 'onboarded', users: 90 },
    { step: 'created_interview', users: 60 },
    { step: 'started_interview', users: 50 },
    { step: 'completed_interview', users: 40 },
    { step: 'viewed_report', users: 36 },
    { step: 'paid', users: 6 },
  ],
  providerHealth: [
    {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      status: 'DEGRADED',
      errorRate: 0.12,
      p95LatencyMs: 2400,
      windowStart: '2026-09-24T05:00:00.000Z',
    },
  ],
  usdToInr: 84,
  computedAt: '2026-09-24T01:00:00.000Z',
  ...overrides,
});

const costReport = (groupBy: CostReport['groupBy']): CostReport => ({
  range: { from: '2026-08-26', to: '2026-09-24' },
  groupBy,
  rows:
    groupBy === 'provider'
      ? [
          { key: 'openai', calls: 900, failures: 4, costMinor: 200_000 },
          { key: 'deepgram', calls: 300, failures: 0, costMinor: 50_050 },
        ]
      : [
          { key: 'interview.question', calls: 800, failures: 3, costMinor: 150_000 },
          { key: 'stt.live', calls: 400, failures: 1, costMinor: 100_050 },
        ],
  totals: {
    calls: 1200,
    aiCostMinor: 250_050,
    revenueMinor: 1_234_500,
    refundsMinor: 10_000,
    gatewayFeesMinor: 24_690,
    marginMinor: 949_760,
    grossMargin: 0.775,
    completedInterviews: 40,
    aiCostPerInterviewMinor: 6_251,
  },
  margin: [
    { day: '2026-09-23', revenueMinor: 49_900, aiCostMinor: 12_000, marginMinor: 36_902 },
    { day: '2026-09-24', revenueMinor: 99_800, aiCostMinor: 15_000, marginMinor: 82_804 },
  ],
  usdToInr: 84,
});

describe('analytics navigation and access', () => {
  it('shows finance admins analytics but not system operations', async () => {
    await renderAt('/', ['FINANCE_ADMIN'], {
      'GET /admin/analytics/dashboard': () => ok(dashboard()),
    });
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const analytics = within(nav).getByRole('list', { name: 'Analytics' });
    expect(within(analytics).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(within(analytics).getByRole('link', { name: 'Costs & margin' })).toBeInTheDocument();
    expect(within(nav).getAllByRole('link', { name: 'Dashboard' })).toHaveLength(1);
    for (const name of ['System health', 'Queues', 'Feature flags', 'Settings']) {
      expect(within(nav).queryByRole('link', { name })).not.toBeInTheDocument();
    }
    // Finance cannot recompute rollups (queues.manage).
    await screen.findByRole('group', { name: 'Completion rate' });
    expect(screen.queryByRole('button', { name: 'Recompute this range' })).not.toBeInTheDocument();
  });

  it('keeps a plain dashboard for admins without analytics', async () => {
    const { api } = await renderAt('/', ['CONTENT_ADMIN']);
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Costs & margin' })).not.toBeInTheDocument();
    expect(screen.getByText('Analytics are not part of your role')).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'GET /admin/analytics/dashboard')).toBe(false);
  });

  it('blocks the costs page without analytics.read', async () => {
    await renderAt('/analytics/costs', ['SUPPORT_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
  });
});

describe('analytics dashboard', () => {
  it('shows KPIs against targets, charts, the funnel and provider health', async () => {
    const { api } = await renderAt('/', ['OPERATIONS_ADMIN'], {
      'GET /admin/analytics/dashboard': () => ok(dashboard()),
    });
    const completion = await screen.findByRole('group', { name: 'Completion rate' });
    expect(within(completion).getByText('80%')).toBeInTheDocument();
    expect(within(completion).getByText('On target')).toBeInTheDocument();
    expect(within(completion).getByText('Target at least 70%')).toBeInTheDocument();

    const freeToPaid = screen.getByRole('group', { name: 'Free → paid conversion' });
    expect(within(freeToPaid).getByText('4%')).toBeInTheDocument();
    expect(within(freeToPaid).getByText('Off target')).toBeInTheDocument();
    expect(within(freeToPaid).getByText('Target at least 5%')).toBeInTheDocument();

    const failure = screen.getByRole('group', { name: 'Technical failure rate' });
    expect(within(failure).getByText('2%')).toBeInTheDocument();
    expect(within(failure).getByText('On target')).toBeInTheDocument();
    expect(within(failure).getByText('Limit at most 3%')).toBeInTheDocument();
    expect(within(failure).getByText('1 failed interview')).toBeInTheDocument();

    const margin = screen.getByRole('group', { name: 'Gross margin' });
    expect(within(margin).getByText('75%')).toBeInTheDocument();
    expect(within(margin).getByText('On target')).toBeInTheDocument();

    expect(
      within(screen.getByRole('group', { name: 'Revenue' })).getByText('₹12,345.00'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'AI cost' })).getByText('₹2,500.50'),
    ).toBeInTheDocument();
    expect(screen.getByText(/AI costs are converted at ₹84 per US dollar\./)).toBeInTheDocument();
    expect(screen.getByText(/Data as of/)).toBeInTheDocument();

    // Charts are images with a text summary, and their values are one click away.
    const chart = screen.getByRole('img', { name: /Interviews started vs completed: 2 days/ });
    expect(chart).toHaveAccessibleName(expect.stringContaining('Interviews started 7'));
    const user = userEvent.setup();
    const [toggle] = screen.getAllByRole('button', { name: 'Show data table' });
    await user.click(toggle!);
    const table = screen.getByRole('table', { name: 'Interviews started vs completed' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);

    const funnel = screen.getByRole('region', { name: 'Cohort funnel' });
    expect(within(funnel).getByText('Completed onboarding')).toBeInTheDocument();
    expect(within(funnel).getByText('90 users')).toBeInTheDocument();
    expect(within(funnel).getByText('75% of previous step')).toBeInTheDocument();
    expect(within(funnel).getByText('Paid')).toBeInTheDocument();
    expect(within(funnel).getByText('16.7% of previous step')).toBeInTheDocument();

    const health = screen.getByRole('region', { name: 'AI provider health' });
    expect(within(health).getByText('OpenAI / gpt-4.1-mini')).toBeInTheDocument();
    expect(within(health).getByText('Degraded')).toBeInTheDocument();
    expect(within(health).getByText(/Errors 12%/)).toBeInTheDocument();

    expect(queriesTo(api, '/admin/analytics/dashboard')[0]).toEqual(presetRange(30));
  });

  it('refetches with the chosen range', async () => {
    const { api, router } = await renderAt('/', ['FINANCE_ADMIN'], {
      'GET /admin/analytics/dashboard': () => ok(dashboard()),
    });
    await screen.findByRole('group', { name: 'Completion rate' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await expect
      .poll(() => queriesTo(api, '/admin/analytics/dashboard').at(-1))
      .toEqual(presetRange(7));
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(router.state.location.search).toBe(
      `?from=${presetRange(7).from}&to=${presetRange(7).to}`,
    );

    // A custom range is validated before it is applied.
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    const apply = screen.getByRole('button', { name: 'Apply range' });
    fireEvent.change(from, { target: { value: '2026-09-10' } });
    fireEvent.change(to, { target: { value: '2026-09-01' } });
    await user.click(apply);
    expect(screen.getByText('The start date must not be after the end date.')).toBeInTheDocument();
    fireEvent.change(from, { target: { value: '2025-01-01' } });
    await user.click(apply);
    expect(screen.getByText('Choose at most 366 days.')).toBeInTheDocument();
    fireEvent.change(from, { target: { value: '2026-08-01' } });
    await user.click(apply);
    await expect
      .poll(() => queriesTo(api, '/admin/analytics/dashboard').at(-1))
      .toEqual({ from: '2026-08-01', to: '2026-09-01' });
  });

  it('recomputes the selected range with a reason', async () => {
    const { api } = await renderAt('/?from=2026-09-01&to=2026-09-10', ['SUPER_ADMIN'], {
      'GET /admin/analytics/dashboard': () => ok(dashboard()),
      'POST /admin/analytics/rollup': () => ok({ days: 10 }),
    });
    await screen.findByRole('group', { name: 'Completion rate' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Recompute this range' }));
    expect(
      screen.getByText(
        'Recompute the daily rollups for 10 days (2026-09-01 to 2026-09-10) from the source data.',
      ),
    ).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Recompute' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(REASON), 'Backfill after the fix');
    await user.click(confirm);
    expect(await screen.findByText('Recomputed 10 days.')).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /admin/analytics/rollup')!.body).toEqual({
      from: '2026-09-01',
      to: '2026-09-10',
      reason: 'Backfill after the fix',
    });
    await expect
      .poll(() => api.calls.filter((c) => c.key === 'GET /admin/analytics/dashboard').length)
      .toBeGreaterThan(1);
  });

  it('shows missing rates as no data', async () => {
    await renderAt('/', ['FINANCE_ADMIN'], {
      'GET /admin/analytics/dashboard': () =>
        ok(
          dashboard({
            kpis: { ...dashboard().kpis, completionRate: null, grossMargin: null },
            computedAt: null,
          }),
        ),
    });
    const completion = await screen.findByRole('group', { name: 'Completion rate' });
    expect(within(completion).getByText('—')).toBeInTheDocument();
    expect(within(completion).getByText('No data')).toBeInTheDocument();
    expect(
      screen.getByText(/No daily rollups have been computed for this range yet\./),
    ).toBeInTheDocument();
  });
});

describe('costs and margin', () => {
  it('switches the grouping and shows totals and the margin chart', async () => {
    // The handler answers for the grouping the page asked for.
    const current: { api: ReturnType<typeof fakeApi> | null } = { api: null };
    const { api, router } = await renderAt('/analytics/costs', ['FINANCE_ADMIN'], {
      'GET /admin/analytics/costs': () => {
        const last = current.api ? queriesTo(current.api, '/admin/analytics/costs').at(-1) : null;
        return ok(costReport((last?.groupBy ?? 'feature') as CostReport['groupBy']));
      },
    });
    current.api = api;
    const table = await screen.findByRole('table');
    expect(within(table).getByText('interview.question')).toBeInTheDocument();
    expect(within(table).getByText('Ask the next interview question')).toBeInTheDocument();
    expect(within(table).getByText('₹1,500.00')).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'AI cost per completed interview' })).getByText(
        '₹62.51',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'AI cost per completed interview' })).getByText(
        '40 completed interviews',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Gross margin' })).getByText('77.5%'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Daily revenue, AI cost and margin: 2 days/ }),
    ).toBeInTheDocument();
    expect(queriesTo(api, '/admin/analytics/costs')[0]).toEqual({
      ...presetRange(30),
      groupBy: 'feature',
    });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Group AI cost by'), 'provider');
    await expect
      .poll(() => queriesTo(api, '/admin/analytics/costs').at(-1))
      .toEqual({ ...presetRange(30), groupBy: 'provider' });
    expect(await screen.findByRole('columnheader', { name: 'Provider' })).toBeInTheDocument();
    expect(await screen.findByRole('rowheader', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Deepgram' })).toBeInTheDocument();
    expect(router.state.location.search).toContain('groupBy=provider');
  });
});
