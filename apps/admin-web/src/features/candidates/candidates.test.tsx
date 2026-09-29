import type {
  AdminMeResponse,
  AdminRole,
  CandidateDetail,
  MfaChallenge,
  MfaStatus,
  Permission,
} from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';

function adminMe(roles: AdminRole[]): AdminMeResponse {
  return {
    ...makeUser({ id: 'admin-1', email: 'root@codebegun.com', adminRoles: roles }),
    permissions: [...permissionsFor(roles)] as Permission[],
  };
}

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

const CANDIDATE_ID = '64f0c0ffee0000000000abcd';

const detail = (status: CandidateDetail['candidate']['status'] = 'ACTIVE'): CandidateDetail => ({
  candidate: {
    id: CANDIDATE_ID,
    displayName: 'Asha Rao',
    email: 'asha@example.com',
    mobile: null,
    status,
    lastLoginAt: '2026-09-28T10:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    experienceLevel: 'FRESHER',
    currentRole: null,
    preferredInterviewLanguage: 'auto',
    productUpdatesOptIn: false,
    identities: [{ provider: 'EMAIL', display: 'a***a@example.com' }],
    deletionScheduledFor: null,
    suspension:
      status === 'SUSPENDED'
        ? { at: '2026-09-29T10:00:00.000Z', reason: 'Abusive uploads', by: 'admin-1' }
        : null,
  },
  credits: { available: 2, reserved: 0 },
  interviews: [],
  purchases: [],
  consents: [],
});

describe('candidates console', () => {
  it('searches candidates and opens one', async () => {
    const api = signedInAs(['SUPPORT_ADMIN'], {
      'GET /admin/candidates': () =>
        ok({
          items: [
            {
              id: CANDIDATE_ID,
              displayName: 'Asha Rao',
              email: 'asha@example.com',
              mobile: null,
              status: 'ACTIVE',
              lastLoginAt: null,
              createdAt: '2026-09-01T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      [`GET /admin/candidates/${CANDIDATE_ID}`]: () => ok(detail()),
    });
    const router = await renderAt('/candidates', api);
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText('Email, mobile number or name'),
      'asha@example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(router.state.location.search).toBe('?q=asha%40example.com'));
    await user.click(await screen.findByRole('link', { name: 'Asha Rao' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Asha Rao/ })).toBeVisible();
    expect(screen.getByText('2 available, 0 reserved')).toBeInTheDocument();
    // Support can read but not suspend.
    expect(screen.queryByRole('button', { name: 'Suspend account' })).not.toBeInTheDocument();
  });

  it('suspends a candidate with a reason', async () => {
    let status: CandidateDetail['candidate']['status'] = 'ACTIVE';
    const api = signedInAs(['OPERATIONS_ADMIN'], {
      [`GET /admin/candidates/${CANDIDATE_ID}`]: () => ok(detail(status)),
      [`POST /admin/candidates/${CANDIDATE_ID}/suspend`]: () => {
        status = 'SUSPENDED';
        return { status: 204 };
      },
    });
    await renderAt(`/candidates/${CANDIDATE_ID}`, api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Suspend account' }));
    await user.type(screen.getByLabelText(/reason/i), 'Abusive uploads');
    await user.click(screen.getByRole('button', { name: 'Suspend account' }));
    expect(await screen.findByText(/Suspended on .*: Abusive uploads/)).toBeInTheDocument();
    expect(
      api.calls.find((c) => c.key === `POST /admin/candidates/${CANDIDATE_ID}/suspend`)!.body,
    ).toEqual({ reason: 'Abusive uploads' });
    expect(screen.getByRole('button', { name: 'Lift suspension' })).toBeInTheDocument();
  });

  it('hides the Candidates section from admins without candidates.read', async () => {
    await renderAt('/', signedInAs(['CONTENT_ADMIN']));
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).queryByRole('link', { name: 'Candidates' })).not.toBeInTheDocument();
  });
});

describe('admin two-factor sign-in', () => {
  const challenge = (mode: 'VERIFY' | 'ENROLL'): MfaChallenge => ({
    mfaRequired: true,
    mfaToken: 't'.repeat(43),
    mode,
    enrollment:
      mode === 'ENROLL'
        ? { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' }
        : null,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });

  it('asks for the authenticator code after the password', async () => {
    const api = fakeApi({
      'POST /admin/auth/password/login': () => ok(challenge('VERIFY')),
      'POST /admin/auth/mfa/verify': () => ok({ ...makeSession(), recoveryCodes: null }),
      'GET /admin/me': () => ok(adminMe(['SUPER_ADMIN'])),
    });
    const router = await renderAt('/login', api);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'root@codebegun.com');
    await user.type(screen.getByLabelText('Password'), 'Blue-Tiger-Runs-42');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { name: 'Enter your authenticator code' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.calls.find((c) => c.key === 'POST /admin/auth/mfa/verify')!.body).toEqual({
      mfaToken: 't'.repeat(43),
      code: '123456',
    });
  });

  it('sets up the authenticator at sign-in and shows recovery codes once', async () => {
    const api = fakeApi({
      'POST /admin/auth/password/login': () => ok(challenge('ENROLL')),
      'POST /admin/auth/mfa/verify': () =>
        ok({ ...makeSession(), recoveryCodes: ['abcd-efgh-jk', 'mnpq-rstu-vw'] }),
      'GET /admin/me': () => ok(adminMe(['SUPER_ADMIN'])),
    });
    const router = await renderAt('/login', api);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'root@codebegun.com');
    await user.type(screen.getByLabelText('Password'), 'Blue-Tiger-Runs-42');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('mfa-secret')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');
    // The otpauth link is also shown as a QR code to scan.
    const qr = screen.getByRole('img', { name: /QR code to add CareerPilot Interview Admin/ });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')!.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    await user.type(screen.getByLabelText('6-digit code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Turn on and sign in' }));
    expect(await screen.findByText('abcd-efgh-jk')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    await user.click(screen.getByRole('button', { name: 'I have saved these codes' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('shows 2FA status on the account page and cannot turn off a required factor', async () => {
    const status: MfaStatus = {
      enabled: true,
      required: true,
      enabledAt: '2026-09-20T10:00:00.000Z',
      recoveryCodesRemaining: 9,
    };
    await renderAt(
      '/account',
      signedInAs(['SUPER_ADMIN'], {
        'GET /admin/auth/mfa': () => ok(status),
        'GET /admin/auth/sessions': () => ok([]),
      }),
    );
    expect(await screen.findByText('9 recovery codes left.', { exact: false })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Get new recovery codes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
  });
});
