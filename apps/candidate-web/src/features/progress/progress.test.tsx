import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeInterview } from '../../test/interview-fixtures';
import { makeDrillResult, makeEmptyProgress, makeProgress } from '../../test/progress-fixtures';
import { makeReport } from '../../test/report-fixtures';
import { renderRoute } from '../../test/render';
import { areaLink, drillPath, signed } from './progress-format';

// jsdom has no canvas: the chart is replaced by its accessible name (the table has the data).
vi.mock('react-chartjs-2', () => ({
  Line: (props: { 'aria-label'?: string }) => (
    <canvas role="img" aria-label={props['aria-label']} />
  ),
}));

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const bodyOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.findLast((c) => c.key === key)?.body;

describe('progress hub (dashboard)', () => {
  it('shows a designed empty state to a new candidate', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /users/me/progress': () => ok(makeEmptyProgress()),
      'GET /interviews': () => ok([]),
      'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
    });
    await renderRoute('/app', { api });

    expect(
      await screen.findByRole('heading', {
        name: 'Your progress starts with your first interview',
      }),
    ).toBeInTheDocument();
    const starts = screen.getAllByRole('link', { name: /Start an interview/ });
    expect(starts.every((l) => l.getAttribute('href') === '/app/new')).toBe(true);
    expect(screen.getByRole('button', { name: /Quick drill/ })).toBeDisabled();
    expect(screen.getByText(/Finish one to unlock them/)).toBeInTheDocument();
    expect(screen.getByText('0-day streak')).toBeInTheDocument();
    const badges = screen.getByRole('region', { name: 'Milestones' });
    expect(within(badges).getByText('0 of 7')).toBeInTheDocument();
    // Practice tiles are real links: without skills yet, to a new interview.
    const areas = screen.getByRole('region', { name: 'What you can practise' });
    expect(within(areas).getByRole('link', { name: /Technical/ })).toHaveAttribute(
      'href',
      '/app/new',
    );
  });

  it('shows readiness, trends, the plan, streak and badges, with the chart data as a table', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /users/me/progress': () => ok(makeProgress()),
      'GET /interviews': () => ok([makeInterview({ state: 'REPORT_READY' })]),
      'GET /credits/balance': () => ok({ available: 2, reserved: 0, lots: [] }),
      'PUT /users/me/progress/plan-items': (body) =>
        ok({ ...makeProgress().plan!.items[0], done: (body as { done: boolean }).done }),
    });
    await renderRoute('/app', { api });

    expect(
      await screen.findByText('Your readiness: 67/100 · Interview-ready with gaps'),
    ).toBeInTheDocument();
    expect(screen.getByText('+12 since your last attempt')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Quick drill/ })).toHaveAttribute(
      'href',
      drillPath('sql'),
    );

    const readiness = screen.getByRole('region', { name: 'Readiness over time' });
    expect(
      await within(readiness).findByRole('img', {
        name: 'Readiness chart: 2 scored interviews, from 55 to 67 out of 100.',
      }),
    ).toBeInTheDocument();
    const table = within(readiness).getByRole('table', {
      name: 'Readiness per interview, oldest first',
    });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('67')).toBeInTheDocument();

    const skills = screen.getByRole('region', { name: 'Skills' });
    expect(within(skills).getByRole('link', { name: 'Practise SQL' })).toHaveAttribute(
      'href',
      '/app/drills/new?dimension=sql',
    );
    expect(within(skills).getByRole('rowheader', { name: 'Teamwork' })).toBeInTheDocument();
    expect(within(skills).getByText('70, 81 (drill)')).toBeInTheDocument();

    const plan = screen.getByRole('region', { name: 'Your plan' });
    expect(within(plan).getByText('1 of 2 done')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(plan).getByRole('checkbox', { name: 'Write three JOIN queries.' }));
    await waitFor(() =>
      expect(bodyOf(api, 'PUT /users/me/progress/plan-items')).toEqual({
        sessionId: 'int1',
        revision: 0,
        itemId: 'next24h.0',
        done: true,
      }),
    );
    expect(within(plan).getByRole('link', { name: 'Practise SQL' })).toBeInTheDocument();

    const streak = screen.getByRole('region', { name: 'Streak and goals' });
    expect(within(streak).getByText('2-day streak')).toBeInTheDocument();
    expect(within(streak).getByText('This week: 2 of 3 sessions')).toBeInTheDocument();
    expect(within(streak).getByText(/10 days to your interview/)).toBeInTheDocument();
    expect(within(streak).getByRole('link', { name: 'Drill: SQL' })).toBeInTheDocument();

    const badges = screen.getByRole('region', { name: 'Milestones' });
    expect(within(badges).getByText('1 of 7')).toBeInTheDocument();
    const areas = screen.getByRole('region', { name: 'What you can practise' });
    expect(within(areas).getByRole('link', { name: /Behavioural|Behavioral/ })).toHaveAttribute(
      'href',
      drillPath('teamwork'),
    );
    expect(screen.getByRole('region', { name: 'Recent drills' })).toBeInTheDocument();
  });

  it('saves the weekly goal and target date', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /users/me/progress': () => ok(makeProgress()),
      'GET /interviews': () => ok([]),
      'GET /credits/balance': () => ok({ available: 2, reserved: 0, lots: [] }),
      'PUT /users/me/progress/goals': () =>
        ok(makeProgress({ goals: { ...makeProgress().goals, weeklyTarget: 5 } })),
    });
    await renderRoute('/app', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change goals' }));
    await user.selectOptions(screen.getByLabelText('Weekly goal'), '5');
    await user.click(screen.getByRole('button', { name: 'Save goals' }));
    await waitFor(() =>
      expect(bodyOf(api, 'PUT /users/me/progress/goals')).toEqual({
        weeklyTarget: 5,
        targetDate: '2026-10-09',
      }),
    );
    expect(await screen.findByText('This week: 2 of 5 sessions')).toBeInTheDocument();
  });

  it('is translated into Telugu and Hindi', async () => {
    for (const lng of ['te', 'hi'] as const) {
      const api = fakeApi({
        ...signedIn,
        'GET /users/me/progress': () => ok(makeProgress()),
        'GET /interviews': () => ok([]),
        'GET /credits/balance': () => ok({ available: 2, reserved: 0, lots: [] }),
      });
      const { unmount } = await renderRoute('/app', { api, lng });
      const expected = lng === 'te' ? 'మీ ప్రణాళిక' : 'आपकी योजना';
      expect(await screen.findByRole('heading', { name: expected })).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/progress\.\w+/);
      unmount();
    }
  });
});

describe('practice drills', () => {
  it('starts a text drill straight into the room', async () => {
    const drill = makeInterview({
      id: 'd2',
      kind: 'DRILL',
      drill: { competencyKey: 'sql', competencyName: 'SQL', sourceSessionId: 'int1' },
      title: 'SQL',
    });
    const api = fakeApi({
      ...signedIn,
      'GET /users/me/progress': () => ok(makeProgress()),
      'POST /drills': () => ok(drill),
      'POST /interviews/d2/start': () => ok({ ...drill, state: 'ACTIVE', credit: 'FREE' }),
    });
    const { router } = await renderRoute('/app/drills/new?dimension=sql', { api });
    expect(await screen.findByRole('heading', { name: 'Drill: SQL' })).toBeInTheDocument();
    expect(screen.getByText('3 questions on this skill, about 7 minutes.')).toBeInTheDocument();
    expect(screen.getByText('Free: 2 of 3 drills left today.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start the drill' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/interviews/d2/room'));
    expect(bodyOf(api, 'POST /drills')).toEqual({ dimensionKey: 'sql', mode: 'TEXT' });
  });

  it('sends a voice drill to the device check', async () => {
    const drill = makeInterview({ id: 'd3', kind: 'DRILL', mode: 'VOICE', voice: null });
    const api = fakeApi({
      ...signedIn,
      'GET /users/me/progress': () => ok(makeProgress()),
      'POST /drills': () => ok(drill),
    });
    const { router } = await renderRoute('/app/drills/new?dimension=sql', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Voice/ }));
    await user.click(screen.getByRole('button', { name: 'Start the drill' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/d3/device-check'),
    );
  });

  it('explains the daily limit with an upgrade path', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /users/me/progress': () =>
        ok(
          makeProgress({
            drills: { freePerDay: 3, usedToday: 3, remainingToday: 0, questions: 3 },
          }),
        ),
    });
    await renderRoute('/app/drills/new?dimension=sql', { api });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/used today's free drills/);
    expect(screen.getByRole('button', { name: 'Start the drill' })).toBeDisabled();
    expect(within(alert).getByRole('link', { name: 'Buy credits' })).toHaveAttribute(
      'href',
      '/pricing',
    );
  });

  it('shows the server refusal when the quota ran out meanwhile', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /users/me/progress': () => ok(makeProgress()),
      'POST /drills': () => fail(402, 'DRILL_LIMIT_REACHED'),
    });
    await renderRoute('/app/drills/new?dimension=sql', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start the drill' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/More are free tomorrow/);
  });

  it('lets candidates pick a skill when the link names none', async () => {
    const api = fakeApi({ ...signedIn, 'GET /users/me/progress': () => ok(makeProgress()) });
    await renderRoute('/app/drills/new', { api });
    expect(
      await screen.findByRole('heading', { name: 'Choose a skill to practise' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /SQL/ })).toHaveAttribute('href', drillPath('sql'));
  });

  it('shows a drill result with the change and feedback per question', async () => {
    const api = fakeApi({ ...signedIn, 'GET /drills/d2': () => ok(makeDrillResult()) });
    await renderRoute('/app/drills/d2', { api });
    expect(await screen.findByRole('heading', { name: 'Drill result: SQL' })).toBeInTheDocument();
    expect(screen.getByText('Before: 48 (+12)')).toBeInTheDocument();
    expect(screen.getByText('Used GROUP BY with HAVING correctly.')).toBeInTheDocument();
    expect(screen.getByText('Not answered.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Practise again/ })).toHaveAttribute(
      'href',
      drillPath('sql'),
    );
  });

  it('waits while the drill is being scored', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /drills/d2': () => ok(makeDrillResult({ state: 'PROCESSING', score: null })),
    });
    await renderRoute('/app/drills/d2', { api });
    expect(await screen.findByText(/Scoring your answers/)).toBeInTheDocument();
  });
});

describe('certificates', () => {
  const flagOn = { 'GET /flags': () => ok({ 'reports.publicProof': true }) };

  it('issues a certificate from a qualifying report', async () => {
    const issued = {
      eligible: true,
      minBand: 'READY_WITH_GAPS',
      certificate: {
        code: 'CPI-ABCD-EFGH-JKLM',
        issuedAt: '2026-09-29T10:00:00.000Z',
        pdfReady: false,
        verifyPath: '/verify/CPI-ABCD-EFGH-JKLM',
      },
    };
    const api = fakeApi({
      ...signedIn,
      ...flagOn,
      'GET /reports/int1': () => ok(makeReport()),
      'GET /feedback/int1': () => ok(null),
      'GET /reports/int1/shares': () => ok([]),
      'GET /reports/int1/certificate': () =>
        ok({ eligible: true, minBand: 'READY_WITH_GAPS', certificate: null }),
      'POST /reports/int1/certificate': () => ok(issued),
    });
    await renderRoute('/app/reports/int1', { api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create certificate' }));
    expect(await screen.findByText(/Certificate CPI-ABCD-EFGH-JKLM/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /verify\/CPI-ABCD-EFGH-JKLM/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preparing the PDF…' })).toBeDisabled();
  });

  it('verifies a certificate publicly and reports unknown codes', async () => {
    const api = fakeApi({
      'GET /certificates/CPI-ABCD-EFGH-JKLM': () =>
        ok({
          code: 'CPI-ABCD-EFGH-JKLM',
          candidateName: 'Asha',
          roleTitle: 'Backend Developer',
          overall: 72,
          band: 'READY_WITH_GAPS',
          completedAt: '2026-09-20T10:00:00.000Z',
          issuedAt: '2026-09-21T10:00:00.000Z',
          superseded: false,
        }),
    });
    await renderRoute('/verify/CPI-ABCD-EFGH-JKLM', { api });
    expect(await screen.findByText('This readiness certificate is genuine.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Asha' })).toBeInTheDocument();
    expect(screen.getByText('72 / 100')).toBeInTheDocument();

    await renderRoute('/verify/CPI-2222-2222-2222', { api: fakeApi() });
    expect(
      await screen.findByRole('heading', { name: 'Certificate not found' }),
    ).toBeInTheDocument();
  });
});

describe('unsubscribe', () => {
  it('unsubscribes with the token from the email, after a click', async () => {
    const api = fakeApi({ 'POST /email/unsubscribe': () => ok({ unsubscribed: true }) });
    await renderRoute('/unsubscribe?token=signed-token-from-email', { api });
    const user = userEvent.setup();
    expect(api.calls.some((c) => c.key === 'POST /email/unsubscribe')).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText(/You will not get practice emails/)).toBeInTheDocument();
    expect(bodyOf(api, 'POST /email/unsubscribe')).toEqual({ token: 'signed-token-from-email' });
  });

  it('explains a missing or bad token', async () => {
    await renderRoute('/unsubscribe', { api: fakeApi() });
    expect(await screen.findByText(/This unsubscribe link is not valid/)).toBeInTheDocument();
  });
});

describe('progress helpers', () => {
  it('links practice areas to the weakest matching skill', () => {
    const progress = makeProgress();
    expect(areaLink(['TECHNICAL', 'DOMAIN'], progress)).toMatchObject({ to: drillPath('sql') });
    expect(areaLink(['PROBLEM_SOLVING'], progress)).toEqual({ to: '/app/new', dimension: null });
    expect(areaLink(['TECHNICAL'], undefined).to).toBe('/app/new');
  });

  it('formats signed changes', () => {
    expect(signed(5)).toBe('+5');
    expect(signed(-3)).toBe('−3');
    expect(signed(0)).toBe('0');
  });
});
