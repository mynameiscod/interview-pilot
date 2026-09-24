import type {
  AdminMeResponse,
  AdminRole,
  FailedJob,
  FeatureFlag,
  Permission,
  QueueCounts,
  SettingEntry,
  SystemHealth,
} from '@cbi/shared-types';
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
const countOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.filter((c) => c.key === key).length;

const queue = (overrides: Partial<QueueCounts> = {}): QueueCounts => ({
  name: 'evaluation',
  waiting: 2,
  active: 1,
  delayed: 0,
  failed: 3,
  completed: 120,
  paused: false,
  ...overrides,
});

const health = (overrides: Partial<SystemHealth> = {}): SystemHealth => ({
  version: '0.11.0',
  env: 'staging',
  dependencies: [
    { name: 'mongodb', ok: true, latencyMs: 3 },
    { name: 'redis', ok: false, latencyMs: null },
  ],
  workers: [
    {
      workerId: 'worker-fresh',
      at: new Date().toISOString(),
      version: '0.11.0',
      queues: ['evaluation', 'documents'],
      ageSec: 12,
    },
    {
      workerId: 'worker-old',
      at: new Date(Date.now() - 300_000).toISOString(),
      version: '0.10.2',
      queues: ['analysis'],
      ageSec: 300,
    },
  ],
  queues: [queue(), queue({ name: 'documents', failed: 0, paused: true })],
  sessions: { live: 4, processing: 6, stuck: 2 },
  maintenance: { enabled: true, message: 'Upgrading the scoring service' },
  ...overrides,
});

const failedJob = (overrides: Partial<FailedJob> = {}): FailedJob => ({
  id: 'job-17',
  name: 'evaluation.stage',
  failedReason: 'Scoring timed out',
  attemptsMade: 3,
  failedAt: '2026-09-24T04:00:00.000Z',
  data: { sessionId: 'int1', stage: 'SCORING' },
  ...overrides,
});

const flag = (overrides: Partial<FeatureFlag> = {}): FeatureFlag => ({
  key: 'reports.publicProof',
  description: 'Candidates can share a read-only proof of their report by link',
  enabled: false,
  rolloutPercent: 100,
  clientVisible: true,
  updatedAt: '2026-09-20T10:00:00.000Z',
  updatedBy: null,
  ...overrides,
});

const settings = (): SettingEntry[] => [
  {
    key: 'maintenance',
    value: { enabled: false, message: '' },
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'finance',
    value: { usdToInr: 84, gatewayFeeRate: 0.02 },
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'admin-1',
  },
  {
    key: 'targets',
    value: { completionRate: 0.7, freeToPaidRate: 0.05, grossMargin: 0.6, maxFailureRate: 0.03 },
    updatedAt: null,
    updatedBy: null,
  },
];

describe('system navigation and access', () => {
  it('shows operations admins the system group', async () => {
    await renderAt('/system/health', ['OPERATIONS_ADMIN'], {
      'GET /admin/system/health': () => ok(health()),
    });
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const system = within(nav).getByRole('list', { name: 'System' });
    for (const name of ['System health', 'Queues', 'Feature flags', 'Settings']) {
      expect(within(system).getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('blocks finance admins from system pages', async () => {
    await renderAt('/system/flags', ['FINANCE_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
  });
});

describe('system health', () => {
  it('highlights stale workers, failing dependencies and stuck interviews', async () => {
    const { router } = await renderAt('/system/health', ['OPERATIONS_ADMIN'], {
      'GET /admin/system/health': () => ok(health()),
      'GET /admin/interviews': () => ok([]),
    });
    expect(await screen.findByText('Environment: STAGING')).toBeInTheDocument();
    expect(screen.getByText('API version 0.11.0')).toBeInTheDocument();
    expect(
      screen.getByText('Maintenance mode is on: new interviews and campaign joins are blocked.'),
    ).toBeInTheDocument();

    const deps = screen.getByRole('region', { name: 'Dependencies' });
    expect(
      within(within(deps).getByText('redis').parentElement!).getByText('Failing'),
    ).toBeInTheDocument();

    const workers = screen.getByRole('region', { name: 'Workers' });
    const stale = within(workers).getByRole('row', { name: /worker-old/ });
    expect(within(stale).getByText('Stale')).toBeInTheDocument();
    expect(within(stale).getByText('5 minutes ago')).toBeInTheDocument();
    const fresh = within(workers).getByRole('row', { name: /worker-fresh/ });
    expect(within(fresh).getByText('Alive')).toBeInTheDocument();
    expect(
      within(workers).getByText('1 worker has not sent a heartbeat for over 90 seconds.'),
    ).toBeInTheDocument();

    const queues = screen.getByRole('region', { name: 'Queues' });
    expect(within(queues).getByText('Paused')).toBeInTheDocument();

    const sessions = screen.getByRole('region', { name: 'Interview sessions' });
    expect(
      within(sessions).getByText(/2 interviews have been processing for more than 30 minutes\./),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(sessions).getByRole('link', { name: 'View processing interviews' }));
    await expect.poll(() => router.state.location.pathname).toBe('/interviews');
    expect(router.state.location.search).toBe('?state=PROCESSING');
  });
});

describe('queues', () => {
  it('retries a failed job with a reason', async () => {
    let jobs = [failedJob(), failedJob({ id: 'job-18' })];
    const { api } = await renderAt('/system/queues', ['OPERATIONS_ADMIN'], {
      'GET /admin/system/queues': () => ok([queue()]),
      'GET /admin/system/queues/evaluation/failed': () => ok(jobs),
      'POST /admin/system/queues/evaluation/jobs/job-17/retry': () => {
        jobs = jobs.filter((j) => j.id !== 'job-17');
        return ok({ retried: true });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Failed jobs in evaluation' }));
    const panel = await screen.findByRole('region', { name: 'Failed jobs in evaluation' });
    expect(await within(panel).findAllByText('Scoring timed out')).toHaveLength(2);
    expect(
      (api.fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls.some(([url]) =>
        url.includes('/failed?limit=25'),
      ),
    ).toBe(true);

    await user.click(within(panel).getByRole('button', { name: 'Retry job-17' }));
    const confirm = within(panel).getByRole('button', { name: 'Retry job' });
    expect(confirm).toBeDisabled();
    await user.type(within(panel).getByLabelText(REASON), 'Provider recovered');
    await user.click(confirm);
    expect(await within(panel).findByText('Job job-17 was queued for retry.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/system/queues/evaluation/jobs/job-17/retry')).toEqual({
      reason: 'Provider recovered',
    });
    await expect
      .poll(() => within(panel).queryByRole('button', { name: 'Retry job-17' }))
      .toBeNull();
    expect(within(panel).getByRole('button', { name: 'Retry job-18' })).toBeInTheDocument();
  });

  it('refreshes the list when the job is no longer failed', async () => {
    let jobs = [failedJob()];
    const { api } = await renderAt('/system/queues', ['SUPER_ADMIN'], {
      'GET /admin/system/queues': () => ok([queue()]),
      'GET /admin/system/queues/evaluation/failed': () => ok(jobs),
      'POST /admin/system/queues/evaluation/jobs/job-17/retry': () => {
        jobs = [];
        return fail(404, 'NOT_FOUND');
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Failed jobs in evaluation' }));
    const panel = await screen.findByRole('region', { name: 'Failed jobs in evaluation' });
    await user.click(await within(panel).findByRole('button', { name: 'Retry job-17' }));
    await user.type(within(panel).getByLabelText(REASON), 'Try again');
    await user.click(within(panel).getByRole('button', { name: 'Retry job' }));
    expect(
      await within(panel).findByText(
        'Job job-17 is no longer failed (it may already have been retried or removed). The list has been refreshed.',
      ),
    ).toBeInTheDocument();
    expect(await within(panel).findByText('No failed jobs in this queue.')).toBeInTheDocument();
    expect(countOf(api, 'GET /admin/system/queues/evaluation/failed')).toBeGreaterThan(1);
  });

  it('hides retry from admins without queues.manage', async () => {
    // No built-in role has system.read without queues.manage; a custom permission set does.
    const api = fakeApi({
      'POST /admin/auth/refresh': () => ok(makeSession()),
      'GET /admin/me': () =>
        ok({ ...adminMe(['OPERATIONS_ADMIN']), permissions: ['system.read'] as Permission[] }),
      'GET /admin/system/queues': () => ok([queue()]),
      'GET /admin/system/queues/evaluation/failed': () => ok([failedJob()]),
    });
    const i18n = await initI18n();
    const manager = createSessionManager({
      baseUrl: 'http://api.test',
      audience: 'admin',
      fetchImpl: api.fetchImpl,
      locks: null,
    });
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider manager={manager} loadUser={loadAdminUser}>
            <RouterProvider
              router={createMemoryRouter(routes, { initialEntries: ['/system/queues'] })}
            />
          </AuthProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Failed jobs in evaluation' }));
    expect(await screen.findByText('Scoring timed out')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument();
  });
});

describe('feature flags', () => {
  it('is read-only for operations admins', async () => {
    await renderAt('/system/flags', ['OPERATIONS_ADMIN'], {
      'GET /admin/flags': () => ok([flag()]),
    });
    expect(await screen.findByText('reports.publicProof')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Turns on Candidate Proof: candidates can share a read-only link to their report.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/A partial rollout applies only to signed-in users/),
    ).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(
      screen.getByText('You can view this page; only super admins can change it.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
  });

  it('lets super admins switch a flag and set its rollout with a reason', async () => {
    let current = flag();
    const { api } = await renderAt('/system/flags', ['SUPER_ADMIN'], {
      'GET /admin/flags': () => ok([current]),
      'PUT /admin/flags/reports.publicProof': (body) => {
        const { enabled, rolloutPercent } = body as { enabled: boolean; rolloutPercent: number };
        current = flag({ enabled, rolloutPercent, updatedBy: 'admin-1' });
        return ok(current);
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit reports.publicProof' }));
    await user.click(screen.getByRole('switch', { name: 'Enabled' }));
    const rollout = screen.getByLabelText('Rollout');
    await user.clear(rollout);
    await user.type(rollout, '150');
    expect(screen.getByText('Enter a whole number from 0 to 100.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(REASON), 'Pilot with a quarter of users');
    expect(screen.getByRole('button', { name: 'Save flag' })).toBeDisabled();
    await user.clear(rollout);
    await user.type(rollout, '25');
    await user.click(screen.getByRole('button', { name: 'Save flag' }));
    expect(await screen.findByText('reports.publicProof was updated.')).toBeInTheDocument();
    expect(bodyOf(api, 'PUT /admin/flags/reports.publicProof')).toEqual({
      enabled: true,
      rolloutPercent: 25,
      reason: 'Pilot with a quarter of users',
    });
    expect(await screen.findByText('On for 25% of signed-in users')).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('is read-only for operations admins', async () => {
    await renderAt('/system/settings', ['OPERATIONS_ADMIN'], {
      'GET /admin/settings': () => ok(settings()),
    });
    const finance = await screen.findByRole('region', { name: 'Finance' });
    expect(within(finance).getByText('₹84')).toBeInTheDocument();
    expect(within(finance).getByText('2%')).toBeInTheDocument();
    const targets = screen.getByRole('region', { name: 'KPI targets' });
    expect(within(targets).getByText('70%')).toBeInTheDocument();
    expect(
      within(targets).getByText(/placeholders until the business sets them/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('validates targets with the shared schema before saving', async () => {
    const { api } = await renderAt('/system/settings', ['SUPER_ADMIN'], {
      'GET /admin/settings': () => ok(settings()),
      'PUT /admin/settings/targets': (body) =>
        ok({
          key: 'targets',
          value: (body as { value: unknown }).value,
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin-1',
        }),
    });
    const targets = await screen.findByRole('region', { name: 'KPI targets' });
    const completion = within(targets).getByLabelText('Completion rate (at least)');
    expect(completion).toHaveValue('70');
    const user = userEvent.setup();
    await user.clear(completion);
    await user.type(completion, '150');
    await user.click(within(targets).getByRole('button', { name: 'Save KPI targets' }));
    expect(within(targets).getByText('Enter a percentage from 0 to 100.')).toBeInTheDocument();
    expect(within(targets).getByText('Enter a reason of 3–300 characters.')).toBeInTheDocument();
    expect(completion).toHaveAttribute('aria-invalid', 'true');
    expect(countOf(api, 'PUT /admin/settings/targets')).toBe(0);

    await user.clear(completion);
    await user.type(completion, '75.5');
    await user.type(within(targets).getByLabelText(REASON), 'Q4 targets agreed');
    await user.click(within(targets).getByRole('button', { name: 'Save KPI targets' }));
    expect(await within(targets).findByText('KPI targets saved.')).toBeInTheDocument();
    expect(bodyOf(api, 'PUT /admin/settings/targets')).toEqual({
      value: {
        completionRate: 0.755,
        freeToPaidRate: 0.05,
        grossMargin: 0.6,
        maxFailureRate: 0.03,
      },
      reason: 'Q4 targets agreed',
    });
  });

  it('saves maintenance mode and shows server validation errors', async () => {
    const { api } = await renderAt('/system/settings', ['SUPER_ADMIN'], {
      'GET /admin/settings': () => ok(settings()),
      'PUT /admin/settings/maintenance': (body) =>
        ok({
          key: 'maintenance',
          value: (body as { value: unknown }).value,
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin-1',
        }),
      'PUT /admin/settings/finance': () =>
        fail(400, 'VALIDATION_FAILED', [{ path: ['usdToInr'], message: 'Rate looks wrong' }]),
    });
    const maintenance = await screen.findByRole('region', { name: 'Maintenance mode' });
    expect(
      within(maintenance).getByText(/new interviews cannot be started and campaign invites/),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(maintenance).getByRole('switch', { name: 'Maintenance mode on' }));
    await user.type(within(maintenance).getByLabelText('Banner message'), '  Back at 6 pm  ');
    await user.type(within(maintenance).getByLabelText(REASON), 'Database upgrade');
    await user.click(within(maintenance).getByRole('button', { name: 'Save maintenance mode' }));
    expect(await within(maintenance).findByText('Maintenance mode saved.')).toBeInTheDocument();
    expect(bodyOf(api, 'PUT /admin/settings/maintenance')).toEqual({
      value: { enabled: true, message: 'Back at 6 pm' },
      reason: 'Database upgrade',
    });

    const finance = screen.getByRole('region', { name: 'Finance' });
    const fee = within(finance).getByLabelText('Payment gateway fee');
    expect(fee).toHaveValue('2');
    await user.clear(fee);
    await user.type(fee, '25');
    await user.type(within(finance).getByLabelText(REASON), 'New gateway contract');
    await user.click(within(finance).getByRole('button', { name: 'Save finance settings' }));
    expect(within(finance).getByText('Enter a percentage from 0 to 20.')).toBeInTheDocument();
    expect(countOf(api, 'PUT /admin/settings/finance')).toBe(0);
    await user.clear(fee);
    await user.type(fee, '2.5');
    await user.click(within(finance).getByRole('button', { name: 'Save finance settings' }));
    expect(await within(finance).findByText('Rate looks wrong')).toBeInTheDocument();
    expect(bodyOf(api, 'PUT /admin/settings/finance')).toEqual({
      value: { usdToInr: 84, gatewayFeeRate: 0.025 },
      reason: 'New gateway contract',
    });
  });
});
