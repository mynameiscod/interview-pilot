import { ApiClientError } from '@cbi/web-core';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { inputErrorMessage } from '../features/interviews/messages';
import { initI18n } from '../i18n';
import { makeInterview } from '../test/interview-fixtures';
import { renderRoute } from '../test/render';
import { MAINTENANCE_DISMISSED_KEY } from './MaintenanceBanner';

const LOAD = { timeout: 15_000 };
const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const NOTICE = 'Upgrading our servers until 6 pm IST.';

const status =
  (enabled: boolean, message = NOTICE) =>
  () =>
    ok({ maintenance: { enabled, message } });

describe('maintenance mode', () => {
  afterEach(() => sessionStorage.clear());

  it('shows the admin notice across the site and hides it for the session when dismissed', async () => {
    const api = fakeApi({ 'GET /system/status': status(true) });
    await renderRoute('/', { api });
    const user = userEvent.setup();

    const banner = await screen.findByText(NOTICE, {}, LOAD);
    expect(banner.closest('[role="status"]')).toHaveTextContent('Scheduled maintenance.');
    await user.click(screen.getByRole('button', { name: 'Dismiss the maintenance notice' }));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(MAINTENANCE_DISMISSED_KEY)).toBe(NOTICE);
  });

  it('stays hidden after dismissal, but shows again when the notice changes', async () => {
    sessionStorage.setItem(MAINTENANCE_DISMISSED_KEY, NOTICE);
    const first = await renderRoute('/', { api: fakeApi({ 'GET /system/status': status(true) }) });
    await screen.findByRole('link', { name: 'Get started' }, LOAD);
    await waitFor(() =>
      expect(first.api.calls.some((c) => c.key === 'GET /system/status')).toBe(true),
    );
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    first.unmount();

    await renderRoute('/', {
      api: fakeApi({ 'GET /system/status': status(true, 'Payments are paused for an hour.') }),
    });
    expect(await screen.findByText('Payments are paused for an hour.', {}, LOAD)).toBeVisible();
  });

  it('uses a default notice when the admin left the message empty', async () => {
    await renderRoute('/', { api: fakeApi({ 'GET /system/status': status(true, '') }) });
    expect(
      await screen.findByText(
        /We are doing maintenance. New interviews cannot be started/,
        {},
        LOAD,
      ),
    ).toBeInTheDocument();
  });

  it('shows nothing when maintenance is off or the status cannot be loaded', async () => {
    const off = await renderRoute('/', { api: fakeApi({ 'GET /system/status': status(false) }) });
    await screen.findByRole('link', { name: 'Get started' }, LOAD);
    await waitFor(() =>
      expect(off.api.calls.some((c) => c.key === 'GET /system/status')).toBe(true),
    );
    expect(screen.queryByText('Scheduled maintenance.')).not.toBeInTheDocument();
    off.unmount();

    // The fake API answers 404 for the status by default.
    await renderRoute('/');
    await screen.findByRole('link', { name: 'Get started' }, LOAD);
    expect(screen.queryByText('Scheduled maintenance.')).not.toBeInTheDocument();
  });

  it("shows the admin's message when starting an interview is refused for maintenance", async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview()),
      'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
      'POST /interviews/int1/start': () => ({
        status: 503,
        body: { error: { code: 'MAINTENANCE', message: NOTICE, requestId: 'test' } },
      }),
    });
    await renderRoute('/app/interviews/int1/start', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Start interview' }, LOAD));
    expect(await screen.findByRole('alert')).toHaveTextContent(NOTICE);
  });

  it('maps the MAINTENANCE error (also used when joining a campaign) to the admin message', async () => {
    const i18n = await initI18n({ detect: false, lng: 'en' });
    const t = i18n.getFixedT('en');
    expect(inputErrorMessage(t, new ApiClientError('MAINTENANCE', NOTICE, 503))).toBe(NOTICE);
    expect(inputErrorMessage(t, new ApiClientError('MAINTENANCE', ' ', 503))).toMatch(
      /We are doing maintenance/,
    );
  });
});
