import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { safeNextPath } from '@cbi/web-core';
import { fail, fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { renderRoute } from '../../test/render';

const challenge = {
  challengeId: 'ch1',
  sentTo: 'a***a@example.com',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  resendAvailableAt: new Date(Date.now() + 30_000).toISOString(),
};

describe('sign-in flow', () => {
  it('sends signed-out visitors of protected pages to sign in', async () => {
    const { router } = await renderRoute('/app/profile');
    expect(
      await screen.findByRole('heading', { name: 'Sign in or create your account' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?next=%2Fapp%2Fprofile');
  });

  it('signs a new person in with an email code and continues to onboarding', async () => {
    const api = fakeApi({
      'POST /auth/otp/request': () => ({ status: 202, body: { data: challenge } }),
      'POST /auth/otp/verify': () => ok(makeSession(makeUser({ onboardingCompleted: false }))),
    });
    const { router } = await renderRoute('/login', { api });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email address'), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(
      await screen.findByText('We sent a 6-digit code to a***a@example.com.'),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));

    expect(
      await screen.findByRole('heading', { name: 'Tell us a little about you' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/onboarding');
    expect(api.calls.find((c) => c.key === 'POST /auth/otp/verify')!.body).toEqual({
      challengeId: 'ch1',
      code: '123456',
    });
  });

  it('shows how many attempts are left after a wrong code', async () => {
    const api = fakeApi({
      'POST /auth/otp/request': () => ({ status: 202, body: { data: challenge } }),
      'POST /auth/otp/verify': () => fail(400, 'OTP_INVALID', { remainingAttempts: 4 }),
    });
    await renderRoute('/login', { api });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code is not correct. 4 attempts left.',
    );
  });

  it('validates the email before calling the API', async () => {
    const api = fakeApi();
    await renderRoute('/login', { api });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address.');
    expect(api.calls.some((c) => c.key === 'POST /auth/otp/request')).toBe(false);
  });

  it('explains a resend cooldown in the chosen language', async () => {
    const api = fakeApi({
      'POST /auth/otp/request': () => fail(429, 'OTP_COOLDOWN', { retryAfterSec: 21 }),
    });
    await renderRoute('/login', { api, lng: 'hi' });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('ईमेल पता'), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: 'कोड भेजें' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('21 सेकंड');
  });

  it('offers mobile sign-in only when the server enables it', async () => {
    const api = fakeApi({
      'GET /auth/providers': () =>
        ok({ google: { enabled: false }, email: { enabled: true }, mobile: { enabled: false } }),
    });
    await renderRoute('/login', { api });
    await screen.findByLabelText('Email address');
    expect(screen.queryByRole('button', { name: 'Mobile' })).not.toBeInTheDocument();
  });

  it('shows sign-in as unavailable when email sign-in is not set up', async () => {
    const api = fakeApi({
      'GET /auth/providers': () =>
        ok({ google: { enabled: false }, email: { enabled: false }, mobile: { enabled: false } }),
    });
    await renderRoute('/login', { api });
    expect(
      await screen.findByRole('heading', { name: 'Sign-in is temporarily unavailable' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('We cannot send sign-in codes by email right now. Please try again later.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send code' })).not.toBeInTheDocument();
  });

  it('shows the unavailable state in Telugu', async () => {
    const api = fakeApi({
      'GET /auth/providers': () =>
        ok({ google: { enabled: false }, email: { enabled: false }, mobile: { enabled: false } }),
    });
    await renderRoute('/login', { api, lng: 'te' });
    expect(
      await screen.findByRole('heading', { name: 'సైన్ ఇన్ తాత్కాలికంగా అందుబాటులో లేదు' }),
    ).toBeInTheDocument();
  });

  it('switches to the unavailable state when a code request finds email not set up', async () => {
    const api = fakeApi({
      'POST /auth/otp/request': () => fail(503, 'NOT_CONFIGURED'),
    });
    await renderRoute('/login', { api });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign-in is temporarily unavailable' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });

  it('switches to mobile and sends the number as typed (the server normalizes it)', async () => {
    const api = fakeApi({
      'POST /auth/otp/request': () => ({
        status: 202,
        body: { data: { ...challenge, sentTo: '+91 ******3210' } },
      }),
    });
    await renderRoute('/login', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mobile' }));
    await user.type(screen.getByLabelText('Mobile number'), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByText(/\+91 \*{6}3210/);
    expect(api.calls.find((c) => c.key === 'POST /auth/otp/request')!.body).toEqual({
      channel: 'MOBILE',
      destination: '98765 43210',
    });
  });
});

describe('session restore and onboarding', () => {
  it('restores the session from the refresh cookie and skips the login page', async () => {
    const api = fakeApi({ 'POST /auth/refresh': () => ok(makeSession()) });
    const { router } = await renderRoute('/login', { api });
    expect(await screen.findByRole('heading', { name: 'Welcome, Asha' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/app');
    expect(api.calls.find((c) => c.key === 'POST /auth/refresh')!.headers['x-cb-csrf']).toBe('1');
  });

  it('requires a name, then saves onboarding and opens the dashboard', async () => {
    const pending = makeUser({
      onboardingCompleted: false,
      profile: { ...makeUser().profile, displayName: null },
    });
    const api = fakeApi({
      'POST /auth/refresh': () => ok(makeSession(pending)),
      'PATCH /users/me/profile': (body) =>
        ok(
          makeUser({
            profile: {
              ...makeUser().profile,
              displayName: (body as { displayName: string }).displayName,
            },
          }),
        ),
    });
    const { router } = await renderRoute('/app', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Please enter your name.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Your name'), 'Ravi');
    await user.selectOptions(screen.getByLabelText('Preferred interview language'), 'te');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Ravi' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/app');
    expect(api.calls.find((c) => c.key === 'PATCH /users/me/profile')!.body).toEqual({
      displayName: 'Ravi',
      preferredInterviewLanguage: 'te',
      experienceLevel: null,
      currentRole: null,
      productUpdatesOptIn: false,
    });
  });

  it('signs out and returns to the landing page', async () => {
    const api = fakeApi({
      'POST /auth/refresh': () => ok(makeSession()),
      'POST /auth/logout': () => ({ status: 204 }),
    });
    const { router } = await renderRoute('/app', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('safeNextPath', () => {
  it('only allows same-app relative paths', () => {
    expect(safeNextPath('/app/profile')).toBe('/app/profile');
    expect(safeNextPath(null)).toBe('/app');
    expect(safeNextPath('https://evil.example')).toBe('/app');
    expect(safeNextPath('//evil.example')).toBe('/app');
    expect(safeNextPath('/\\evil.example')).toBe('/app');
  });
});
