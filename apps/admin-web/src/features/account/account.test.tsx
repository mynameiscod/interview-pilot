import type { AdminMeResponse, Permission } from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fail, fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';

const STRONG = 'correct horse battery staple';

function adminMe(hasPassword: boolean): AdminMeResponse {
  return {
    ...makeUser({ id: 'admin-1', email: 'root@codebegun.com', adminRoles: ['SUPPORT_ADMIN'] }),
    permissions: [...permissionsFor(['SUPPORT_ADMIN'])] as Permission[],
    hasPassword,
  };
}

async function renderAccount(hasPassword: boolean, handlers: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(adminMe(hasPassword)),
    ...handlers,
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
          <RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/account'] })} />
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { api };
}

const bodyOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.find((c) => c.key === key)!.body;
const countOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.filter((c) => c.key === key).length;

describe('account page', () => {
  it('is available to every admin role', async () => {
    await renderAccount(false);
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Password sign-in' })).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAccessibleDescription(
      'At least 12 characters. Use a passphrase you do not use anywhere else.',
    );
  });

  it('validates length and confirmation before calling the API', async () => {
    const { api } = await renderAccount(false);
    const user = userEvent.setup();
    const next = await screen.findByLabelText('New password');
    const confirm = screen.getByLabelText('Repeat the new password');

    await user.type(next, 'short');
    await user.type(confirm, 'short');
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 12 characters.');

    await user.clear(next);
    await user.type(next, STRONG);
    await user.clear(confirm);
    await user.type(confirm, `${STRONG}!`);
    await user.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The passwords do not match.');
    expect(countOf(api, 'POST /admin/auth/password')).toBe(0);
  });

  it('sets a first password without asking for a current one', async () => {
    const { api } = await renderAccount(false, {
      'POST /admin/auth/password': () => ok({ ok: true }),
    });
    expect(
      await screen.findByText('Set a password to sign in without waiting for an email code.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), STRONG);
    await user.type(screen.getByLabelText('Repeat the new password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Save password' }));

    expect(await screen.findByText('Password saved.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/auth/password')).toEqual({ newPassword: STRONG });
    // The page now reflects that a password exists, and the form is cleared.
    expect(
      screen.getByText('You can sign in with your email and password, or with an email code.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Repeat the new password')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('changes an existing password with the current one', async () => {
    const { api } = await renderAccount(true, {
      'POST /admin/auth/password': () => ok({ ok: true }),
    });
    expect(
      await screen.findByText(
        'You can sign in with your email and password, or with an email code.',
      ),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Current password'), 'old passphrase here');
    await user.type(screen.getByLabelText('New password'), STRONG);
    await user.type(screen.getByLabelText('Repeat the new password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Save password' }));

    expect(await screen.findByText('Password saved.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/auth/password')).toEqual({
      currentPassword: 'old passphrase here',
      newPassword: STRONG,
    });
  });

  it('shows the API error and keeps what was typed', async () => {
    await renderAccount(true, {
      'POST /admin/auth/password': () => fail(400, 'INVALID_CREDENTIALS'),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Current password'), 'wrong passphrase');
    await user.type(screen.getByLabelText('New password'), STRONG);
    await user.type(screen.getByLabelText('Repeat the new password'), STRONG);
    await user.click(screen.getByRole('button', { name: 'Save password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email or password is incorrect.',
    );
    expect(screen.queryByText('Password saved.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveValue(STRONG);
    expect(screen.getByRole('button', { name: 'Save password' })).toBeEnabled();
  });
});
