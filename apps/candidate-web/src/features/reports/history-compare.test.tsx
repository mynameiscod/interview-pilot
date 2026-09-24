import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderRoute } from '../../test/render';
import { makeCompare, makeHistoryItem } from '../../test/report-fixtures';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
/** The first render loads the lazy route, which can be slow on a busy machine. */
const LOAD = { timeout: 15_000 };

const history = [
  makeHistoryItem({
    sessionId: 'int3',
    title: 'Data Analyst',
    companyName: null,
    roleKey: 'data-analyst',
    overall: null,
    band: 'INSUFFICIENT_EVIDENCE',
    confidence: 'LOW',
    endedAt: '2026-09-22T10:00:00.000Z',
  }),
  makeHistoryItem({ sessionId: 'int2', overall: 70, endedAt: '2026-09-21T10:00:00.000Z' }),
  makeHistoryItem({ sessionId: 'int1', endedAt: '2026-09-20T10:00:00.000Z' }),
];

describe('history', () => {
  it('lists reports newest first with links and text for score and confidence', async () => {
    const api = fakeApi({ ...signedIn, 'GET /reports': () => ok(history) });
    await renderRoute('/app/history', { api });

    const table = await screen.findByRole('table', { name: 'Your readiness reports' }, LOAD);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Data Analyst');
    expect(rows[0]).toHaveTextContent('Not enough evidence yet');
    expect(rows[0]).toHaveTextContent('Low');
    expect(rows[1]).toHaveTextContent('70/100');
    expect(rows[1]).toHaveTextContent('Interview-ready with gaps');
    expect(rows[1]).toHaveTextContent('Medium');
    expect(rows[1]).toHaveTextContent('25 minutes');
    expect(rows[1]).toHaveTextContent('English');
    expect(within(rows[2]!).getByRole('link', { name: /Backend Developer/ })).toHaveAttribute(
      'href',
      '/app/reports/int1',
    );
    expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/app/history');
  });

  it('enables Compare only for 2–4 attempts at the same role', async () => {
    const api = fakeApi({ ...signedIn, 'GET /reports': () => ok(history) });
    const { router } = await renderRoute('/app/history', { api });
    const user = userEvent.setup();

    const compare = await screen.findByRole('button', { name: 'Compare' }, LOAD);
    expect(compare).toBeDisabled();
    expect(compare).toHaveAccessibleDescription('Select at least 2 attempts to compare.');

    const boxes = screen.getAllByRole('checkbox');
    await user.click(boxes[1]!);
    expect(compare).toBeDisabled();
    await user.click(boxes[0]!);
    expect(compare).toBeDisabled();
    expect(compare).toHaveAccessibleDescription('Only attempts at the same role can be compared.');

    await user.click(boxes[0]!);
    await user.click(boxes[2]!);
    expect(compare).toBeEnabled();
    expect(compare).toHaveAccessibleDescription('2 attempts selected.');
    await user.click(compare);
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/compare'));
    expect(router.state.location.search).toBe('?sessions=int1,int2');
  });

  it('allows at most four attempts', async () => {
    const five = [1, 2, 3, 4, 5].map((n) =>
      makeHistoryItem({ sessionId: `s${n}`, endedAt: `2026-09-0${n}T10:00:00.000Z` }),
    );
    const api = fakeApi({ ...signedIn, 'GET /reports': () => ok(five) });
    await renderRoute('/app/history', { api });
    const user = userEvent.setup();
    const compare = await screen.findByRole('button', { name: 'Compare' }, LOAD);
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    expect(compare).toBeDisabled();
    expect(compare).toHaveAccessibleDescription('You can compare up to 4 attempts at a time.');
  });

  it('invites the candidate to start when there are no reports', async () => {
    const api = fakeApi({ ...signedIn, 'GET /reports': () => ok([]) });
    await renderRoute('/app/history', { api });
    expect(
      await screen.findByRole('heading', { name: 'No reports yet' }, LOAD),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start an interview' })).toHaveAttribute(
      'href',
      '/app/new',
    );
  });
});

describe('compare', () => {
  it('shows attempts as columns and each skill change in text', async () => {
    const api = fakeApi({ ...signedIn, 'GET /reports/compare': () => ok(makeCompare()) });
    await renderRoute('/app/compare?sessions=int0,int1', { api });

    const table = await screen.findByRole('table', { name: 'Scores for each attempt' }, LOAD);
    expect(api.calls.some((c) => c.key === 'GET /reports/compare')).toBe(true);
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual([
      'Skill',
      expect.stringContaining('Attempt 1'),
      expect.stringContaining('Attempt 2'),
      'Change',
    ]);
    const cells = (name: RegExp) =>
      within(within(table).getByRole('row', { name }))
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells(/^Overall/)).toEqual(['50/100', '64/100', '+14 (improved)']);
    expect(cells(/^Evidence confidence/)).toEqual(['Low', 'Medium', '–']);
    expect(cells(/^Node\.js/)).toEqual(['60/100', '72/100', '+12 (improved)']);
    expect(cells(/^SQL/)).toEqual(['55/100', '48/100', '−7 (declined)']);
    expect(cells(/^Testing/)).toEqual(['Not assessed', 'Not assessed', 'Not enough data']);
  });

  it('explains when the attempts cannot be compared', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /reports/compare': () => fail(400, 'VALIDATION_FAILED'),
    });
    await renderRoute('/app/compare?sessions=int0,int9', { api });
    expect(
      await screen.findByRole('heading', { name: 'These attempts cannot be compared' }, LOAD),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to history' })).toHaveAttribute(
      'href',
      '/app/history',
    );
  });

  it('does not ask the server about a single attempt', async () => {
    const api = fakeApi({ ...signedIn });
    await renderRoute('/app/compare?sessions=int0', { api });
    expect(
      await screen.findByRole('heading', { name: 'These attempts cannot be compared' }, LOAD),
    ).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'GET /reports/compare')).toBe(false);
  });
});
