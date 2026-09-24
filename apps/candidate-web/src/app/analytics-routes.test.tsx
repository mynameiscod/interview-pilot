import { fail, fakeApi } from '@cbi/web-core/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initAnalytics,
  resetAnalytics,
  type AnalyticsSender,
  type TrackEventsPayload,
} from '../lib/analytics';
import { renderRoute } from '../test/render';

const LOAD = { timeout: 15_000 };

function startTracker() {
  const batches: TrackEventsPayload[] = [];
  const send: AnalyticsSender = vi.fn(async (body) => {
    batches.push(body);
  });
  const tracker = initAnalytics({ send, storage: null, flushIntervalMs: 60_000 });
  const events = () => {
    tracker.flush();
    return batches.flatMap((b) => b.events);
  };
  return { send, events };
}

describe('analytics in the app', () => {
  afterEach(() => resetAnalytics());

  it('sends nothing unless a tracker was started', async () => {
    const api = fakeApi({ 'GET /proof/tok_secret_1': () => fail(404, 'NOT_FOUND') });
    await renderRoute('/proof/tok_secret_1', { api });
    await screen.findByRole('heading', { name: 'This proof link is not available' }, LOAD);
    expect(api.calls.some((c) => c.key.includes('analytics'))).toBe(false);
  });

  it('records page views by route pattern, never the real URL or token', async () => {
    const { events } = startTracker();
    await renderRoute('/proof/tok_secret_1', {
      api: fakeApi({ 'GET /proof/tok_secret_1': () => fail(404, 'NOT_FOUND') }),
    });
    await screen.findByRole('heading', { name: 'This proof link is not available' }, LOAD);

    const sent = events();
    expect(sent).toContainEqual(
      expect.objectContaining({ name: 'page_view', path: '/proof/:token' }),
    );
    expect(JSON.stringify(sent)).not.toContain('tok_secret_1');
  });

  it('tracks the landing call to action, then the sign-in page', async () => {
    const { events } = startTracker();
    const { router } = await renderRoute('/');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('link', { name: 'Get started' }, LOAD));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    await screen.findByRole('heading', { level: 1 }, LOAD);

    await waitFor(() =>
      expect(events().map((e) => [e.name, e.path])).toEqual([
        ['page_view', '/'],
        ['landing_cta_clicked', '/'],
        ['page_view', '/login'],
        ['signup_started', '/login'],
      ]),
    );
  });
});
