import type { ActiveSession, LegalInfo } from '@cbi/shared-types';
import { createSessionManager } from '@cbi/web-core';
import { fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetOnSignOut } from '../../app/session';
import { renderRoute } from '../../test/render';
import { makeJobTarget } from '../../test/interview-fixtures';
import {
  initialWizardState,
  loadWizardState,
  saveWizardState,
} from '../interviews/wizard/wizard-state';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };

const legal = (overrides: Partial<LegalInfo> = {}): LegalInfo => ({
  grievanceOfficer: { name: 'Priya Officer', email: 'grievance@example.com', address: null },
  draft: true,
  lastUpdated: null,
  recordingRetentionDays: 90,
  deletionGraceDays: 7,
  ...overrides,
});

const device = (overrides: Partial<ActiveSession> = {}): ActiveSession => ({
  id: '11111111-1111-4111-8111-111111111111',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
  signedInAt: '2026-09-20T10:00:00.000Z',
  lastActiveAt: '2026-09-28T10:00:00.000Z',
  expiresAt: '2026-10-28T10:00:00.000Z',
  current: true,
  ...overrides,
});

describe('privacy page', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:export');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('downloads the data export', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const api = fakeApi({
      ...signedIn,
      'GET /legal': () => ok(legal()),
      'GET /users/me/consents': () => ok([]),
      'GET /users/me/export': () =>
        ok({ format: 'careerpilot-interview-export/v1', generatedAt: '2026-09-29T08:00:00.000Z' }),
    });
    await renderRoute('/app/privacy', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Download my data' }));
    expect(await screen.findByText('Your download has started.')).toBeInTheDocument();
    expect(click).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('deletes the account after typing DELETE and explains how to cancel', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /legal': () => ok(legal()),
      'GET /users/me/consents': () => ok([]),
      'DELETE /users/me': () => ({
        status: 202,
        body: { data: { scheduledFor: '2026-10-06T08:00:00.000Z', graceDays: 7 } },
      }),
    });
    const { router } = await renderRoute('/app/privacy', { api });
    const user = userEvent.setup();

    expect(await screen.findByText(/permanently erased after 7 days/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    const typed = screen.getByLabelText('Or type DELETE to confirm');
    await user.type(typed, 'delete');
    const form = typed.closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Type DELETE exactly');
    expect(api.calls.some((c) => c.key === 'DELETE /users/me')).toBe(false);

    await user.clear(typed);
    await user.type(typed, 'DELETE');
    await user.click(within(form).getByRole('button', { name: 'Delete my account' }));
    expect(
      await screen.findByRole('heading', { name: 'Your account is scheduled for deletion' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account-deleted');
    // This tab is signed out too (the server already ended every session).
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'DELETE /users/me')!.body).toEqual({
      method: 'TYPED',
      confirmText: 'DELETE',
    });
  });

  it('can confirm deletion with a code sent to the candidate’s email', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /legal': () => ok(legal()),
      'GET /users/me/consents': () => ok([]),
      'POST /users/me/reauth/otp': () => ({
        status: 202,
        body: {
          data: {
            challengeId: 'ch1',
            sentTo: 'a***a@example.com',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            resendAvailableAt: new Date(Date.now() + 30_000).toISOString(),
          },
        },
      }),
      'DELETE /users/me': () => ({
        status: 202,
        body: { data: { scheduledFor: '2026-10-06T08:00:00.000Z', graceDays: 7 } },
      }),
    });
    await renderRoute('/app/privacy', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete my account' }));
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    await user.type(await screen.findByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.key === 'DELETE /users/me')?.body).toEqual({
        method: 'OTP',
        challengeId: 'ch1',
        code: '123456',
      }),
    );
  });

  it('shows the grievance officer from the server and a Keep option that closes the form', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /legal': () => ok(legal()),
      'GET /users/me/consents': () => ok([]),
    });
    await renderRoute('/app/privacy', { api });
    const user = userEvent.setup();
    expect(await screen.findByText('Priya Officer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'grievance@example.com' })).toHaveAttribute(
      'href',
      'mailto:grievance@example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    await user.click(screen.getByRole('button', { name: 'Keep my account' }));
    expect(screen.queryByLabelText('Or type DELETE to confirm')).not.toBeInTheDocument();
  });
});

describe('legal pages', () => {
  it('shows the draft banner, the texts and the officer on the Privacy Notice', async () => {
    await renderRoute('/privacy-policy', { api: fakeApi({ 'GET /legal': () => ok(legal()) }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy Notice' })).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('Draft — pending legal review.');
    expect(await screen.findByText('Priya Officer')).toBeInTheDocument();
    expect(screen.getByText(/OpenAI/)).toBeInTheDocument();
  });

  it('hides the banner after sign-off and never invents an officer', async () => {
    await renderRoute('/grievance', {
      api: fakeApi({
        'GET /legal': () =>
          ok(legal({ draft: false, grievanceOfficer: { name: null, email: null, address: null } })),
      }),
    });
    expect(
      await screen.findByText(/contact details will be published here soon/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('explains AI scoring in Telugu too', async () => {
    await renderRoute('/how-scoring-works', {
      lng: 'te',
      api: fakeApi({ 'GET /legal': () => ok(legal()) }),
    });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/AI/);
    expect(screen.getByRole('note')).toHaveTextContent('డ్రాఫ్ట్');
  });

  it('links the terms and privacy notice from the sign-in page and the footer', async () => {
    await renderRoute('/login');
    const agreement = (await screen.findByText(/By continuing, you agree/)).closest('p')!;
    expect(within(agreement).getByRole('link', { name: 'Terms of Use' })).toHaveAttribute(
      'href',
      '/terms',
    );
    expect(within(agreement).getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute(
      'href',
      '/privacy-policy',
    );
    const footer = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(footer).getByRole('link', { name: 'How AI scoring works' })).toHaveAttribute(
      'href',
      '/how-scoring-works',
    );
  });
});

describe('profile: sign-in methods and devices', () => {
  it('does not claim a method was linked when the form is cancelled', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /auth/sessions': () => ok([device()]),
      'GET /users/me/consents': () => ok([]),
    });
    await renderRoute('/app/profile', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a sign-in method' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Added to your account.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a sign-in method' })).toBeInTheDocument();
  });

  it('shows the success message after a method is really linked', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /auth/sessions': () => ok([device()]),
      'GET /users/me/consents': () => ok([]),
      'POST /auth/link/otp/request': () => ({
        status: 202,
        body: {
          data: {
            challengeId: 'ch1',
            sentTo: 'r***i@example.com',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            resendAvailableAt: new Date(Date.now() + 30_000).toISOString(),
          },
        },
      }),
      'POST /auth/link/otp/verify': () => ok(makeUser()),
    });
    await renderRoute('/app/profile', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a sign-in method' }));
    await user.type(screen.getByLabelText('Email address'), 'ravi@example.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    expect(await screen.findByText('Added to your account.')).toBeInTheDocument();
  });

  it('lists signed-in devices and signs another one out', async () => {
    const other = device({
      id: '22222222-2222-4222-8222-222222222222',
      current: false,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36',
    });
    const api = fakeApi({
      ...signedIn,
      'GET /auth/sessions': () => ok([device(), other]),
      'GET /users/me/consents': () => ok([]),
      [`DELETE /auth/sessions/${other.id}`]: () => ({ status: 204 }),
    });
    await renderRoute('/app/profile', { api });
    const user = userEvent.setup();
    expect(await screen.findByText('This device')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out Chrome · Android' }));
    expect(await screen.findByText('That device has been signed out.')).toBeInTheDocument();
    expect(screen.queryByText('Chrome · Android')).not.toBeInTheDocument();
  });
});

describe('job descriptions in the wizard', () => {
  beforeEach(() => sessionStorage.clear());

  it('deletes a saved job description', async () => {
    saveWizardState({ ...initialWizardState(), step: 2 });
    const job = makeJobTarget({ id: 'jd1', source: 'UPLOAD', originalName: 'backend-jd.pdf' });
    const api = fakeApi({
      ...signedIn,
      'GET /jobs': () => ok([job]),
      'DELETE /jobs/jd1': () => ({ status: 204 }),
    });
    await renderRoute('/app/new', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByText('Your saved job description (1)'));
    await user.click(screen.getByRole('button', { name: 'Delete backend-jd.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Job description deleted.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'DELETE /jobs/jd1')).toBe(true);
  });

  it('forgets the unfinished wizard when the person signs out', async () => {
    saveWizardState({ ...initialWizardState(), step: 2, jdText: 'secret JD text' });
    const manager = createSessionManager({
      baseUrl: 'http://api.test',
      audience: 'candidate',
      fetchImpl: fakeApi({ 'POST /auth/logout': () => ({ status: 204 }) }).fetchImpl,
      locks: null,
      channel: null,
    });
    const clearCache = vi.fn();
    forgetOnSignOut(manager, clearCache);
    manager.start(makeSession());
    expect(loadWizardState()).not.toBeNull();
    await manager.signOut();
    expect(loadWizardState()).toBeNull();
    expect(clearCache).toHaveBeenCalledOnce();
  });
});
