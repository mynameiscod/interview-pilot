import type {
  AdminMeResponse,
  AdminRole,
  AdminUserSummary,
  InviteAdminResponse,
  Permission,
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

const adminUser = (overrides: Partial<AdminUserSummary> = {}): AdminUserSummary => ({
  id: 'admin-2',
  email: 'priya@codebegun.com',
  displayName: 'Priya',
  roles: ['OPERATIONS_ADMIN'],
  status: 'ACTIVE',
  emailVerified: true,
  lastLoginAt: '2026-09-20T10:30:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const self = adminUser({
  id: 'admin-1',
  email: 'root@codebegun.com',
  displayName: 'Root',
  roles: ['SUPER_ADMIN'],
});
const newcomer = adminUser({
  id: 'admin-3',
  email: 'new.hire@codebegun.com',
  displayName: null,
  roles: ['CONTENT_ADMIN', 'SUPPORT_ADMIN'],
  emailVerified: false,
  lastLoginAt: null,
});

describe('admin users list', () => {
  it('shows people, roles, first sign-in state and marks the signed-in admin', async () => {
    await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok([self, adminUser(), newcomer]),
    });
    expect(await screen.findByRole('heading', { name: 'Admin users' })).toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Admin accounts' });

    const priya = await within(list).findByRole('row', { name: /Priya/ });
    expect(within(priya).getByText('priya@codebegun.com')).toBeInTheDocument();
    expect(within(priya).getByText('Operations')).toBeInTheDocument();
    expect(within(priya).queryByText('Not signed in yet')).not.toBeInTheDocument();
    expect(within(priya).queryByText('Never')).not.toBeInTheDocument();
    expect(within(priya).getByRole('button', { name: 'Edit roles' })).toBeInTheDocument();
    expect(within(priya).getByRole('button', { name: 'Revoke access' })).toBeInTheDocument();

    // No display name: the email stands in for the name, and they have never signed in.
    const pending = within(list).getByRole('row', { name: /new\.hire@codebegun\.com/ });
    expect(within(pending).getByText('Not signed in yet')).toBeInTheDocument();
    expect(within(pending).getByText('Never')).toBeInTheDocument();
    expect(within(pending).getByText('Content')).toBeInTheDocument();
    expect(within(pending).getByText('Support')).toBeInTheDocument();

    // Admins cannot edit or revoke themselves.
    const me = within(list).getByRole('row', { name: /Root/ });
    expect(within(me).getByText('You')).toBeInTheDocument();
    expect(within(me).getByText('Super admin')).toBeInTheDocument();
    expect(within(me).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows an error when the list cannot load', async () => {
    await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => fail(500, 'INTERNAL'),
    });
    const list = await screen.findByRole('region', { name: 'Admin accounts' });
    expect(await within(list).findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });

  it('is read-only for admins without admin_users.manage', async () => {
    await renderAt('/admins', ['OPERATIONS_ADMIN'], {
      'GET /admin/users': () => ok([self, adminUser(), newcomer]),
    });
    const list = await screen.findByRole('region', { name: 'Admin accounts' });
    expect(await within(list).findByRole('row', { name: /Priya/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Invite an admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invite' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit roles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke access' })).not.toBeInTheDocument();
  });

  it('blocks admins without admin_users.read', async () => {
    await renderAt('/admins', ['FINANCE_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
  });
});

describe('inviting an admin', () => {
  it('requires a valid email and at least one role', async () => {
    const { api } = await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok([self]),
    });
    const invite = await screen.findByRole('region', { name: 'Invite an admin' });
    const user = userEvent.setup();
    await user.click(within(invite).getByRole('button', { name: 'Send invite' }));
    expect(await within(invite).findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(within(invite).getByRole('alert')).toHaveTextContent('Choose at least one role.');

    await user.type(within(invite).getByLabelText('Work email'), 'not-an-email');
    await user.click(within(invite).getByLabelText('Support'));
    await user.click(within(invite).getByRole('button', { name: 'Send invite' }));
    expect(await within(invite).findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(within(invite).queryByText('Choose at least one role.')).not.toBeInTheDocument();
    expect(countOf(api, 'POST /admin/users')).toBe(0);
  });

  it('sends the invite and refreshes the list', async () => {
    let admins = [self];
    const { api } = await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok(admins),
      'POST /admin/users': (body) => {
        const { email, roles } = body as { email: string; roles: AdminRole[] };
        const created = adminUser({
          id: 'admin-9',
          email,
          displayName: null,
          roles,
          emailVerified: false,
          lastLoginAt: null,
        });
        admins = [...admins, created];
        return ok({ admin: created, inviteEmailSent: true } satisfies InviteAdminResponse);
      },
    });
    const invite = await screen.findByRole('region', { name: 'Invite an admin' });
    const user = userEvent.setup();
    const email = within(invite).getByLabelText('Work email');
    await user.type(email, 'kiran@codebegun.com');
    await user.click(within(invite).getByLabelText('Support'));
    await user.click(within(invite).getByLabelText('Finance'));
    await user.click(within(invite).getByRole('button', { name: 'Send invite' }));

    expect(
      await within(invite).findByText(
        'kiran@codebegun.com now has admin access and has been emailed.',
      ),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/users')).toEqual({
      email: 'kiran@codebegun.com',
      roles: ['SUPPORT_ADMIN', 'FINANCE_ADMIN'],
    });
    // The form resets for the next invite.
    expect(email).toHaveValue('');
    expect(within(invite).getByLabelText('Support')).not.toBeChecked();

    const list = screen.getByRole('region', { name: 'Admin accounts' });
    const row = await within(list).findByRole('row', { name: /kiran@codebegun\.com/ });
    expect(within(row).getByText('Not signed in yet')).toBeInTheDocument();
  });

  it('warns when the invitation email could not be sent', async () => {
    await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok([self]),
      'POST /admin/users': () =>
        ok({
          admin: adminUser({ id: 'admin-9', email: 'kiran@codebegun.com' }),
          inviteEmailSent: false,
        } satisfies InviteAdminResponse),
    });
    const invite = await screen.findByRole('region', { name: 'Invite an admin' });
    const user = userEvent.setup();
    await user.type(within(invite).getByLabelText('Work email'), 'kiran@codebegun.com');
    await user.click(within(invite).getByLabelText('Content'));
    await user.click(within(invite).getByRole('button', { name: 'Send invite' }));
    expect(
      await within(invite).findByText(
        'kiran@codebegun.com now has admin access, but the invitation email could not be sent. Let them know directly.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the API error', async () => {
    await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok([self]),
      'POST /admin/users': () => fail(409, 'IDENTITY_IN_USE'),
    });
    const invite = await screen.findByRole('region', { name: 'Invite an admin' });
    const user = userEvent.setup();
    await user.type(within(invite).getByLabelText('Work email'), 'taken@codebegun.com');
    await user.click(within(invite).getByLabelText('Content'));
    await user.click(within(invite).getByRole('button', { name: 'Send invite' }));
    expect(await within(invite).findByRole('alert')).toHaveTextContent(
      'This is already linked to another account.',
    );
    expect(within(invite).getByLabelText('Work email')).toHaveValue('taken@codebegun.com');
  });
});

describe('changing an admin', () => {
  it('edits roles with a reason', async () => {
    let priya = adminUser();
    const { api } = await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok([self, priya]),
      'PUT /admin/users/admin-2/roles': (body) => {
        priya = { ...priya, roles: (body as { roles: AdminRole[] }).roles };
        return ok(priya);
      },
    });
    const list = await screen.findByRole('region', { name: 'Admin accounts' });
    const user = userEvent.setup();
    const row = await within(list).findByRole('row', { name: /Priya/ });
    await user.click(within(row).getByRole('button', { name: 'Edit roles' }));

    const save = within(list).getByRole('button', { name: 'Save roles' });
    expect(within(list).getByLabelText('Operations')).toBeChecked();
    await user.click(within(list).getByLabelText('Operations'));
    await user.type(within(list).getByLabelText(REASON), 'Moved to content team');
    // At least one role is required.
    expect(save).toBeDisabled();
    await user.click(within(list).getByLabelText('Content'));
    expect(save).toBeEnabled();
    await user.click(save);

    await expect.poll(() => within(list).queryByRole('button', { name: 'Save roles' })).toBeNull();
    expect(bodyOf(api, 'PUT /admin/users/admin-2/roles')).toEqual({
      roles: ['CONTENT_ADMIN'],
      reason: 'Moved to content team',
    });
    const updated = within(list).getByRole('row', { name: /Priya/ });
    expect(await within(updated).findByText('Content')).toBeInTheDocument();
    expect(within(updated).queryByText('Operations')).not.toBeInTheDocument();
  });

  it('requires a reason of at least 3 characters and can be cancelled', async () => {
    const { api } = await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok([self, adminUser()]),
    });
    const list = await screen.findByRole('region', { name: 'Admin accounts' });
    const user = userEvent.setup();
    const row = await within(list).findByRole('row', { name: /Priya/ });
    await user.click(within(row).getByRole('button', { name: 'Edit roles' }));
    const save = within(list).getByRole('button', { name: 'Save roles' });
    expect(save).toBeDisabled();
    await user.type(within(list).getByLabelText(REASON), 'ab');
    expect(save).toBeDisabled();
    await user.click(within(list).getByRole('button', { name: 'Cancel' }));
    expect(within(list).queryByRole('button', { name: 'Save roles' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit roles' })).toBeInTheDocument();
    expect(countOf(api, 'PUT /admin/users/admin-2/roles')).toBe(0);
  });

  it('shows the API error when saving roles fails', async () => {
    await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok([self, adminUser()]),
      'PUT /admin/users/admin-2/roles': () => fail(400, 'VALIDATION_FAILED'),
    });
    const list = await screen.findByRole('region', { name: 'Admin accounts' });
    const user = userEvent.setup();
    const row = await within(list).findByRole('row', { name: /Priya/ });
    await user.click(within(row).getByRole('button', { name: 'Edit roles' }));
    await user.click(within(list).getByLabelText('Support'));
    await user.type(within(list).getByLabelText(REASON), 'Covering support');
    await user.click(within(list).getByRole('button', { name: 'Save roles' }));
    expect(await within(list).findByRole('alert')).toHaveTextContent(
      'Please check the details and try again.',
    );
    // The form stays open so the admin can correct it and retry.
    expect(within(list).getByRole('button', { name: 'Save roles' })).toBeInTheDocument();
  });

  it('revokes admin access with a reason', async () => {
    let admins = [self, adminUser()];
    const { api } = await renderAt('/admins', ['SUPER_ADMIN'], {
      'GET /admin/users': () => ok(admins),
      'POST /admin/users/admin-2/revoke-access': () => {
        admins = admins.filter((a) => a.id !== 'admin-2');
        return ok({ revoked: true });
      },
    });
    const list = await screen.findByRole('region', { name: 'Admin accounts' });
    const user = userEvent.setup();
    const row = await within(list).findByRole('row', { name: /Priya/ });
    await user.click(within(row).getByRole('button', { name: 'Revoke access' }));
    expect(
      within(list).getByText(
        'priya@codebegun.com will lose admin access and be signed out of the admin console. Their candidate account is not affected.',
      ),
    ).toBeInTheDocument();
    const confirm = within(list).getByRole('button', { name: 'Revoke admin access' });
    expect(confirm).toBeDisabled();
    await user.type(within(list).getByLabelText(REASON), 'Left the company');
    await user.click(confirm);

    await expect.poll(() => within(list).queryByRole('row', { name: /Priya/ })).toBeNull();
    expect(bodyOf(api, 'POST /admin/users/admin-2/revoke-access')).toEqual({
      reason: 'Left the company',
    });
  });
});
