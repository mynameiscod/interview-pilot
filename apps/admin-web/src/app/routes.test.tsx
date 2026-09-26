import type { AdminMeResponse, AdminRole, AdminUserSummary, Permission } from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { initI18n } from '../i18n';
import { routes } from './routes';
import { loadAdminUser } from './session';

function adminMe(roles: AdminRole[], email = 'root@codebegun.com'): AdminMeResponse {
  return {
    ...makeUser({ id: 'admin-1', email, adminRoles: roles }),
    permissions: [...permissionsFor(roles)] as Permission[],
  };
}

const summary = (overrides: Partial<AdminUserSummary> = {}): AdminUserSummary => ({
  id: 'admin-2',
  email: 'ops@codebegun.com',
  displayName: null,
  roles: ['OPERATIONS_ADMIN'],
  status: 'ACTIVE',
  emailVerified: true,
  lastLoginAt: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

async function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
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
  return router;
}

const signedInAs = (roles: AdminRole[], extra: Parameters<typeof fakeApi>[0] = {}) =>
  fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(adminMe(roles)),
    ...extra,
  });

describe('admin sign-in', () => {
  it('sends signed-out visitors to the admin sign-in page', async () => {
    const router = await renderAt('/audit', fakeApi());
    expect(
      await screen.findByRole('heading', { name: 'Sign in to the admin console' }),
    ).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=%2Faudit');
  });

  it('signs in with an email code without revealing whether the address is an admin', async () => {
    const api = fakeApi({
      'POST /admin/auth/otp/request': () => ({
        status: 202,
        body: {
          data: {
            challengeId: 'c1',
            sentTo: 'r***t@codebegun.com',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            resendAvailableAt: new Date(Date.now() + 30_000).toISOString(),
          },
        },
      }),
      'POST /admin/auth/otp/verify': () => ok(makeSession()),
      'GET /admin/me': () => ok(adminMe(['SUPER_ADMIN'])),
    });
    const router = await renderAt('/login', api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Email code' }));
    await user.type(await screen.findByLabelText('Work email'), 'root@codebegun.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(
      await screen.findByText(
        'If r***t@codebegun.com has admin access, a 6-digit code is on its way.',
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(
      await screen.findByText('Signed in as root@codebegun.com (Super admin).'),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('admin password sign-in', () => {
  it('signs in with email and password (the default method)', async () => {
    const calls: unknown[] = [];
    const api = fakeApi({
      'POST /admin/auth/password/login': (body) => {
        calls.push(body);
        return ok(makeSession());
      },
      'GET /admin/me': () => ok(adminMe(['SUPER_ADMIN'])),
    });
    const router = await renderAt('/login', api);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'root@codebegun.com');
    await user.type(screen.getByLabelText('Password'), 'Blue-Tiger-Runs-42');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Signed in as root@codebegun.com (Super admin).'),
    ).toBeInTheDocument();
    expect(calls).toEqual([{ email: 'root@codebegun.com', password: 'Blue-Tiger-Runs-42' }]);
    expect(router.state.location.pathname).toBe('/');
  });

  it('shows a wrong-password message', async () => {
    const api = fakeApi({
      'POST /admin/auth/password/login': () => ({
        status: 401,
        body: { error: { code: 'INVALID_CREDENTIALS', message: 'x', requestId: 'r' } },
      }),
    });
    await renderAt('/login', api);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'root@codebegun.com');
    await user.type(screen.getByLabelText('Password'), 'nope-nope-nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('The email or password is incorrect.')).toBeInTheDocument();
  });
});

describe('permission-aware console', () => {
  it('shows only the sections the admin may use', async () => {
    await renderAt('/', signedInAs(['CONTENT_ADMIN']));
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Admin users' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument();
  });

  it('blocks direct navigation to a section without permission', async () => {
    await renderAt('/audit', signedInAs(['CONTENT_ADMIN']));
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
  });

  it('lets operations admins view but not manage admin users', async () => {
    await renderAt(
      '/admins',
      signedInAs(['OPERATIONS_ADMIN'], { 'GET /admin/users': () => ok([summary()]) }),
    );
    expect(await screen.findByText('ops@codebegun.com')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Invite an admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit roles' })).not.toBeInTheDocument();
  });
});

describe('admin user management', () => {
  it('invites an admin with the chosen roles', async () => {
    const api = signedInAs(['SUPER_ADMIN'], {
      'GET /admin/users': () =>
        ok([summary({ id: 'admin-1', email: 'root@codebegun.com', roles: ['SUPER_ADMIN'] })]),
      'POST /admin/users': (body) => ({
        status: 201,
        body: {
          data: {
            admin: summary({ email: (body as { email: string }).email, emailVerified: false }),
            inviteEmailSent: true,
          },
        },
      }),
    });
    await renderAt('/admins', api);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'support@codebegun.com');
    await user.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText('Choose at least one role.')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Support'));
    await user.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(
      await screen.findByText('support@codebegun.com now has admin access and has been emailed.'),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /admin/users')!.body).toEqual({
      email: 'support@codebegun.com',
      roles: ['SUPPORT_ADMIN'],
    });
    // Admins cannot change themselves from this screen.
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('requires a reason before revoking access', async () => {
    const api = signedInAs(['SUPER_ADMIN'], {
      'GET /admin/users': () => ok([summary()]),
      'POST /admin/users/admin-2/revoke-access': () => ({ status: 204 }),
    });
    await renderAt('/admins', api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke access' }));
    const confirm = screen.getByRole('button', { name: 'Revoke admin access' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason (recorded in the audit log)'), 'Left the team');
    await user.click(confirm);
    await screen.findByRole('button', { name: 'Revoke access' });
    expect(
      api.calls.find((c) => c.key === 'POST /admin/users/admin-2/revoke-access')!.body,
    ).toEqual({
      reason: 'Left the team',
    });
  });
});

describe('audit log', () => {
  it('lists entries and loads older pages with the cursor', async () => {
    const entry = (id: string, action: string) => ({
      id,
      at: new Date().toISOString(),
      actorType: 'ADMIN',
      actorId: 'admin-1',
      action,
      resourceType: 'user',
      resourceId: 'admin-2',
      outcome: 'SUCCESS',
      requestId: null,
      details: { reason: 'x' },
    });
    const api = fakeApi({
      'POST /admin/auth/refresh': () => ok(makeSession()),
      'GET /admin/me': () => ok(adminMe(['SUPER_ADMIN'])),
      'GET /admin/audit-logs': () =>
        ok({ items: [entry('e2', 'admin.user_invited')], nextCursor: 'e2' }),
    });
    await renderAt('/audit', api);
    expect(await screen.findByText('admin.user_invited')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load older entries' }));
    await screen.findAllByText('admin.user_invited');
    expect(api.calls.filter((c) => c.key === 'GET /admin/audit-logs')).toHaveLength(2);
  });
});
