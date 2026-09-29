import { INTEGRITY_NOTE, type MediaAssetSummary } from '@cbi/shared-types';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../../config';
import { renderRoute } from '../../test/render';
import { makeReport } from '../../test/report-fixtures';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const LOAD = { timeout: 15_000 };

function makeAsset(overrides: Partial<MediaAssetSummary> = {}): MediaAssetSummary {
  return {
    id: 'a1',
    sessionId: 'int1',
    kind: 'CANDIDATE_VIDEO',
    mimeType: 'video/webm',
    status: 'PARTIAL',
    segmentCount: 11,
    expectedSegments: 12,
    missingSegments: [4],
    parts: 1,
    playbackFile: 'PENDING',
    bytes: 4_000_000,
    durationMs: 120_000,
    retentionExpiresAt: '2026-10-24T10:00:00.000Z',
    deletion: { status: 'NONE', at: null, reason: null },
    createdAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

async function openReport(extra: Parameters<typeof fakeApi>[0] = {}, report = makeReport()) {
  const api = fakeApi({
    ...signedIn,
    'GET /reports/int1': () => ok(report),
    'GET /feedback/int1': () => ok(null),
    ...extra,
  });
  const utils = await renderRoute('/app/reports/int1', { api });
  await screen.findByRole('heading', { level: 1, name: 'Backend Developer' }, LOAD);
  return { ...utils, api };
}

describe('session observations on the report', () => {
  it('lists what was noted in neutral words, with the time away and the note', async () => {
    await openReport(
      {},
      makeReport({
        content: {
          integrity: {
            counts: { TAB_HIDDEN: 2, TAB_VISIBLE: 2, WINDOW_BLUR: 1, PASTE: 1 },
            awaySec: 95,
            timeline: [],
            note: INTEGRITY_NOTE,
          },
        },
      }),
    );

    const section = screen.getByRole('region', { name: 'Session observations' });
    const items = within(section).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Switched to another tab or app · 2 times',
      'The interview window was not in focus · 1 time',
      'Pasted text into an answer · 1 time',
    ]);
    expect(section).toHaveTextContent('Time away from the interview page: about 2 minutes.');
    expect(section).toHaveTextContent(/They are not part of the score/);
    // Observations, not accusations: nothing styled as a warning or an error.
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
    expect(section.querySelector('.alert, .text-danger, .text-warning, .border-danger')).toBeNull();
  });

  it('is not shown when the interview did not track observations', async () => {
    await openReport();
    expect(screen.queryByRole('region', { name: 'Session observations' })).not.toBeInTheDocument();
  });
});

describe('interview recording on the report', () => {
  it('shows the status and retention, plays it from a short-lived link, and deletes it after confirming', async () => {
    const playbackPath = '/api/v1/media/play/a1?exp=1790000000&sig=abc';
    let asset = makeAsset();
    const { api } = await openReport({
      'GET /interviews/int1/media': () => ok(asset),
      'GET /interviews/int1/media/playback-url': () =>
        ok({
          url: playbackPath,
          expiresAt: '2026-09-24T10:30:00.000Z',
          mimeType: 'video/webm',
          source: 'FILE',
          parts: [playbackPath],
        }),
      'DELETE /interviews/int1/media': () => {
        asset = makeAsset({
          deletion: { status: 'DELETED', at: '2026-09-24T10:00:00.000Z', reason: null },
        });
        return ok(asset);
      },
    });
    const user = userEvent.setup();

    const section = await screen.findByRole('region', { name: 'Interview recording' });
    expect(
      within(section).getByText('Partial — some parts could not be saved'),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/Kept until Oct 24, 2026, then deleted automatically/),
    ).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Watch' }));
    const player = await within(section).findByLabelText('Interview recording');
    expect(player.tagName).toBe('VIDEO');
    expect(player).toHaveAttribute('src', `${config.VITE_API_URL}${playbackPath}`);
    expect(player).toHaveAttribute('controls');

    await user.click(within(section).getByRole('button', { name: 'Delete recording' }));
    expect(api.calls.some((c) => c.key === 'DELETE /interviews/int1/media')).toBe(false);
    expect(within(section).getByRole('heading', { name: 'Delete this recording?' })).toHaveFocus();
    await user.click(within(section).getByRole('button', { name: 'Yes, delete it' }));

    expect(await within(section).findByText('This recording was deleted.')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.key === 'DELETE /interviews/int1/media')).toHaveLength(1);
    await waitFor(() =>
      expect(within(section).queryByRole('button', { name: 'Watch' })).not.toBeInTheDocument(),
    );
  });

  it('plays the parts in order until the recording is joined, and renews an expired link in place', async () => {
    const link = (n: number, sig: string) => `/api/v1/media/play/a1?exp=1&part=${n}&sig=${sig}`;
    let issued = 0;
    const { api } = await openReport({
      'GET /interviews/int1/media': () => ok(makeAsset({ parts: 2 })),
      'GET /interviews/int1/media/playback-url': () => {
        issued += 1;
        const sig = `s${issued}`;
        return ok({
          url: link(0, sig),
          expiresAt: '2026-09-24T10:30:00.000Z',
          mimeType: 'video/webm',
          source: 'PARTS',
          parts: [link(0, sig), link(1, sig)],
        });
      },
    });
    const user = userEvent.setup();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const section = await screen.findByRole('region', { name: 'Interview recording' });
    await user.click(within(section).getByRole('button', { name: 'Watch' }));
    const player = (await within(section).findByLabelText(
      'Interview recording',
    )) as HTMLVideoElement;
    expect(player).toHaveAttribute('src', `${config.VITE_API_URL}${link(0, 's1')}`);
    expect(within(section).getByText('Part 1 of 2')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Previous part' })).toBeDisabled();

    // The first part ends: the next one follows.
    fireEvent.ended(player);
    await waitFor(() =>
      expect(player).toHaveAttribute('src', `${config.VITE_API_URL}${link(1, 's1')}`),
    );
    expect(within(section).getByText('Part 2 of 2')).toBeInTheDocument();
    await waitFor(() => expect(play).toHaveBeenCalled());

    // The link expired mid-watch: a new one is fetched and playback continues from the same moment.
    player.currentTime = 42;
    fireEvent.error(player);
    await waitFor(() =>
      expect(player).toHaveAttribute('src', `${config.VITE_API_URL}${link(1, 's2')}`),
    );
    expect(
      api.calls.filter((c) => c.key === 'GET /interviews/int1/media/playback-url'),
    ).toHaveLength(2);
    player.currentTime = 0;
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBe(42);

    // Failing again straight away is not a loop of new links: the candidate is told instead.
    fireEvent.error(player);
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'The recording could not be played.',
    );
    expect(
      api.calls.filter((c) => c.key === 'GET /interviews/int1/media/playback-url'),
    ).toHaveLength(2);
    play.mockRestore();
  });

  it('shows nothing for an interview that was not recorded', async () => {
    const { api } = await openReport({ 'GET /interviews/int1/media': () => ok(null) });
    await waitFor(() =>
      expect(api.calls.some((c) => c.key === 'GET /interviews/int1/media')).toBe(true),
    );
    expect(screen.queryByRole('region', { name: 'Interview recording' })).not.toBeInTheDocument();
  });
});
