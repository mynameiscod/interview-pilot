import {
  permissionsFor,
  type AdminMeResponse,
  type AdminRole,
  type OrgSummary,
  type Permission,
} from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fail, fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';
import { OrgManagerProvider } from '../../org/guards';

const ORG: OrgSummary = {
  id: '64b0000000000000000000f1',
  name: 'City College',
  type: 'COLLEGE',
  status: 'ACTIVE',
  seats: { total: 5, used: 2 },
  interviewQuota: { total: 500, used: 40 },
  wallet: { balance: 120, allocated: 30 },
  mfaRequired: false,
  scorecardCriteria: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

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
    'POST /admin/auth/refresh': () => ok(makeSession(adminMe(roles))),
    'GET /admin/me': () => ok(adminMe(roles)),
    'POST /org/auth/refresh': () => fail(401, 'UNAUTHENTICATED'),
    'GET /admin/orgs': () => ok({ items: [ORG], total: 1, page: 1, pageSize: 25 }),
    ...handlers,
  });
  const i18n = await initI18n();
  const manager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'admin',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  const orgManager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'org',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider manager={manager} loadUser={loadAdminUser}>
          <OrgManagerProvider manager={orgManager}>
            <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
          </OrgManagerProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { api };
}

describe('organisations (CodeBegun admins)', () => {
  it('lets super admins create an organisation and invite its owner', async () => {
    const { api } = await renderAt('/orgs', ['SUPER_ADMIN'], {
      'POST /admin/orgs': () => ok({ org: ORG, inviteEmailSent: true }),
    });
    expect(await screen.findByRole('link', { name: 'City College' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Organisations' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /new organisation/i }));
    await userEvent.type(screen.getByLabelText('Name'), 'Acme Labs');
    await userEvent.type(screen.getByLabelText('Owner email'), 'owner@acme.test');
    await userEvent.clear(screen.getByLabelText('Sponsored interviews in the wallet'));
    await userEvent.type(screen.getByLabelText('Sponsored interviews in the wallet'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Create and invite the owner' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.key === 'POST /admin/orgs')?.body).toEqual({
        name: 'Acme Labs',
        type: 'EMPLOYER',
        seats: 5,
        interviewQuota: null,
        walletCredits: 50,
        mfaRequired: false,
        ownerEmail: 'owner@acme.test',
      }),
    );
  });

  it('shows the list read-only to support and hides it from content admins', async () => {
    await renderAt('/orgs', ['SUPPORT_ADMIN']);
    expect(await screen.findByRole('link', { name: 'City College' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new organisation/i })).toBeNull();
  });

  it('refuses admins without orgs.read', async () => {
    await renderAt('/orgs', ['CONTENT_ADMIN']);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Organisations' })).toBeNull();
  });
});
