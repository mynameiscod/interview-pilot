import type {
  AdminMeResponse,
  AdminRole,
  AuditLogEntry,
  AuditLogPage,
  Permission,
} from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fail, fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';
import { auditParams } from './params';

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
  return { api };
}

/** Query strings of every audit list request, oldest first. */
const listQueries = (api: ReturnType<typeof fakeApi>) =>
  (api.fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls
    .map(([url]) => new URL(url))
    .filter((u) => u.pathname.endsWith('/admin/audit-logs'))
    .map((u) => Object.fromEntries(u.searchParams));

const entry = (overrides: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 'e1',
  at: '2026-09-24T04:00:00.000Z',
  actorType: 'ADMIN',
  actorId: 'admin-1',
  action: 'flag.updated',
  resourceType: 'featureFlag',
  resourceId: 'reports.publicProof',
  outcome: 'SUCCESS',
  requestId: 'req-1',
  details: { reason: 'launch' },
  ...overrides,
});

const page = (items: AuditLogEntry[], nextCursor: string | null = null): AuditLogPage => ({
  items,
  nextCursor,
});

const localStart = (day: string) => new Date(`${day}T00:00:00`).toISOString();

describe('audit log page', () => {
  it('lists entries with actor, resource, outcome and details, and pages older ones', async () => {
    let calls = 0;
    const { api } = await renderAt('/audit', ['OPERATIONS_ADMIN'], {
      'GET /admin/audit-logs': () => {
        calls += 1;
        return calls === 1
          ? ok(
              page(
                [
                  entry(),
                  entry({
                    id: 'e2',
                    actorType: 'SYSTEM',
                    actorId: null,
                    resourceType: null,
                    resourceId: null,
                    outcome: 'FAILURE',
                    details: null,
                    action: 'job.failed',
                  }),
                ],
                'e2',
              ),
            )
          : ok(page([entry({ id: 'e3', action: 'auth.login_succeeded' })]));
      },
    });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('flag.updated')).toBeInTheDocument();
    expect(within(table).getByText('featureFlag:reports.publicProof')).toBeInTheDocument();
    expect(within(table).getByText('{"reason":"launch"}')).toBeInTheDocument();
    expect(within(table).getByText('Failure')).toBeInTheDocument();
    expect(within(table).getByText('System')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load older entries' }));
    expect(await screen.findByText('auth.login_succeeded')).toBeInTheDocument();
    expect(listQueries(api).at(-1)).toEqual({ limit: '50', before: 'e2' });
    expect(screen.queryByRole('button', { name: 'Load older entries' })).not.toBeInTheDocument();
  });

  it('filters by action, actor, resource and a date range (whole days)', async () => {
    const { api } = await renderAt('/audit', ['OPERATIONS_ADMIN'], {
      'GET /admin/audit-logs': () => ok(page([])),
    });
    expect(await screen.findByText('No entries match.')).toBeInTheDocument();
    const user = userEvent.setup();
    const filters = screen.getByRole('form', { name: 'Audit log filters' });
    await user.type(within(filters).getByLabelText('Action'), 'setting.updated');
    await user.type(within(filters).getByLabelText('Actor ID'), ' 64b000000000000000000001 ');
    await user.type(within(filters).getByLabelText('Resource ID'), 'maintenance');
    await user.type(within(filters).getByLabelText('From'), '2026-09-01');
    await user.type(within(filters).getByLabelText('To'), '2026-09-30');
    await user.click(within(filters).getByRole('button', { name: 'Filter' }));

    await expect
      .poll(() => listQueries(api).at(-1))
      .toEqual({
        action: 'setting.updated',
        actorId: '64b000000000000000000001',
        resourceId: 'maintenance',
        from: localStart('2026-09-01'),
        // The end day is included: up to the start of the next day.
        to: localStart('2026-10-01'),
        limit: '50',
      });

    await user.click(within(filters).getByRole('button', { name: 'Clear' }));
    await expect.poll(() => listQueries(api).at(-1)).toEqual({ limit: '50' });
    expect(within(filters).getByLabelText('Action')).toHaveValue('');
  });

  it('refuses a range that ends before it starts', async () => {
    const { api } = await renderAt('/audit', ['OPERATIONS_ADMIN'], {
      'GET /admin/audit-logs': () => ok(page([])),
    });
    await screen.findByText('No entries match.');
    const user = userEvent.setup();
    const filters = screen.getByRole('form', { name: 'Audit log filters' });
    await user.type(within(filters).getByLabelText('From'), '2026-09-10');
    await user.type(within(filters).getByLabelText('To'), '2026-09-01');
    await user.click(within(filters).getByRole('button', { name: 'Filter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The start date must be on or before the end date.',
    );
    expect(listQueries(api)).toHaveLength(1);
  });

  it('shows a load error', async () => {
    await renderAt('/audit', ['OPERATIONS_ADMIN'], {
      'GET /admin/audit-logs': () => fail(500, 'INTERNAL_ERROR'),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Something went wrong/);
  });

  it('hides the page from roles without audit.read', async () => {
    await renderAt('/audit', ['CONTENT_ADMIN']);
    expect(await screen.findByText('You do not have access to this section')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Audit log filters' })).not.toBeInTheDocument();
  });
});

describe('audit log export', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:export');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is offered to super admins only', async () => {
    await renderAt('/audit', ['OPERATIONS_ADMIN'], {
      'GET /admin/audit-logs': () => ok(page([entry()])),
    });
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });

  it('downloads the CSV with the applied filters and the bearer token', async () => {
    const download = vi.fn(
      async () =>
        new Response('\uFEFFid,at\r\n', {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="audit-log-2026-09-29.csv"' },
        }),
    );
    vi.stubGlobal('fetch', download);
    await renderAt('/audit', ['SUPER_ADMIN'], {
      'GET /admin/audit-logs': () => ok(page([entry()])),
    });
    await screen.findByRole('table');
    expect(screen.getByText(/Each export is recorded in the audit log/)).toBeInTheDocument();
    const user = userEvent.setup();
    const filters = screen.getByRole('form', { name: 'Audit log filters' });
    await user.type(within(filters).getByLabelText('Action'), 'flag.updated');
    await user.type(within(filters).getByLabelText('From'), '2026-09-01');
    await user.click(within(filters).getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [url, init] = download.mock.calls[0] as unknown as [string, RequestInit];
    const csv = new URL(url);
    expect(csv.pathname).toBe('/api/v1/admin/audit-logs/export.csv');
    expect(Object.fromEntries(csv.searchParams)).toEqual({
      action: 'flag.updated',
      from: localStart('2026-09-01'),
    });
    expect(init.headers).toEqual({ Authorization: 'Bearer access-token' });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });

  it('shows why an export was refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'FORBIDDEN', message: 'No access', requestId: 'r-1' },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    await renderAt('/audit', ['SUPER_ADMIN'], {
      'GET /admin/audit-logs': () => ok(page([entry()])),
    });
    await screen.findByRole('table');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });
});

describe('audit query parameters', () => {
  it('trims text, skips empty filters and includes the whole last day', () => {
    expect(
      auditParams({
        action: ' a ',
        actorId: '',
        resourceId: '',
        fromDay: '',
        toDay: '',
      }).toString(),
    ).toBe('action=a');
    const params = auditParams({
      action: '',
      actorId: '',
      resourceId: ' r-1 ',
      fromDay: '2026-02-28',
      toDay: '2026-02-28',
    });
    expect(Object.fromEntries(params)).toEqual({
      resourceId: 'r-1',
      from: localStart('2026-02-28'),
      to: localStart('2026-03-01'),
    });
  });
});
