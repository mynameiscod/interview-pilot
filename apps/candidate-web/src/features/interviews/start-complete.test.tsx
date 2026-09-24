import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { makeInterview } from '../../test/interview-fixtures';
import { makeProgress } from '../../test/report-fixtures';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const balance =
  (available: number, reserved = 0) =>
  () =>
    ok({ available, reserved, lots: [] });

describe('start screen', () => {
  it('recaps the rules and credit, then starts the interview and opens the room', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview()),
      'GET /credits/balance': balance(1),
      'POST /interviews/int1/start': () =>
        ok(makeInterview({ state: 'ACTIVE', credit: 'RESERVED' })),
    });
    const { router } = await renderRoute('/app/interviews/int1/start', { api });
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Ready to begin?' })).toBeInTheDocument();
    expect(screen.getByText(/This is a text interview/)).toBeInTheDocument();
    expect(screen.getByText('It takes about 30 minutes.')).toBeInTheDocument();
    expect(screen.getByText(/You will not see scores during the interview/)).toBeInTheDocument();
    expect(screen.getByText(/You have 10 minutes to reconnect/)).toBeInTheDocument();
    const rounds = screen.getByRole('heading', { name: 'Rounds' })
      .nextElementSibling as HTMLElement;
    expect(within(rounds).getByText('Introduction')).toBeInTheDocument();
    expect(within(rounds).getByText('Technical')).toBeInTheDocument();
    expect(screen.getByText('Uses 1 credit')).toBeInTheDocument();
    expect(await screen.findByText('You have 1 credit available.')).toBeInTheDocument();
    expect(screen.getByText(/If you end very early, the credit is returned/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start interview' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/interviews/int1/room'));
    expect(api.calls.filter((c) => c.key === 'POST /interviews/int1/start')).toHaveLength(1);
  });

  it('explains when there are no credits left and links to pricing', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview()),
      'GET /credits/balance': balance(0),
      'POST /interviews/int1/start': () => fail(402, 'INSUFFICIENT_CREDITS'),
    });
    const { router } = await renderRoute('/app/interviews/int1/start', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Start interview' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You have no credits left');
    expect(alert).toHaveTextContent('Buy credits to continue.');
    expect(within(alert).getByRole('link', { name: 'See plans and buy credits' })).toHaveAttribute(
      'href',
      '/pricing',
    );
    expect(router.state.location.pathname).toBe('/app/interviews/int1/start');
  });

  it('points to the dashboard when another interview is in progress', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview()),
      'GET /credits/balance': balance(0, 1),
      'POST /interviews/int1/start': () => fail(409, 'CONFLICT'),
    });
    await renderRoute('/app/interviews/int1/start', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Start interview' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You already have an interview in progress');
    expect(within(alert).getByRole('link', { name: 'Go to your dashboard' })).toHaveAttribute(
      'href',
      '/app',
    );
  });

  it('goes straight to the room for an interview in progress', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'PAUSED', credit: 'RESERVED' })),
    });
    const { router } = await renderRoute('/app/interviews/int1/start', { api });
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/interviews/int1/room'));
  });
});

describe('complete screen', () => {
  it('thanks the candidate and shows that the credit was used', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'PROCESSING', credit: 'CONSUMED' })),
      'GET /interviews/int1/progress': () => ok(makeProgress()),
    });
    await renderRoute('/app/interviews/int1/complete', { api });

    expect(
      await screen.findByRole('heading', { name: 'Thank you for completing your interview' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Your readiness report is being prepared\./)).toBeInTheDocument();
    expect(screen.getByText('1 credit used')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/app');
  });

  it('shows the evaluation stages as a checklist while the report is prepared', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'PROCESSING', credit: 'CONSUMED' })),
      'GET /interviews/int1/progress': () => ok(makeProgress()),
    });
    await renderRoute('/app/interviews/int1/complete', { api });

    const list = await screen.findByRole('list');
    const step = async (name: string) => (await within(list).findByText(name)).closest('li');
    expect(await step('Reviewing your answers')).toHaveTextContent('(done)');
    expect(await step('Scoring each skill')).toHaveTextContent('(in progress)');
    expect(await step('Writing your plan')).toHaveTextContent('(waiting)');
    expect(await step('Preparing your report')).toHaveTextContent('(waiting)');
    expect(screen.queryByRole('link', { name: 'View your report' })).not.toBeInTheDocument();
  });

  it('keeps polling and links to the report once it is ready', async () => {
    let calls = 0;
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'PROCESSING', credit: 'CONSUMED' })),
      'GET /interviews/int1/progress': () => {
        calls += 1;
        return ok(
          calls === 1
            ? makeProgress()
            : makeProgress({
                stage: 'RENDER_PDF',
                completedStages: [
                  'FINALIZE_TRANSCRIPT',
                  'EXTRACT_EVIDENCE',
                  'SCORE_DIMENSIONS',
                  'AGGREGATE',
                  'RECOMMENDATIONS',
                  'BUILD_REPORT',
                ],
                reportReady: true,
              }),
        );
      },
    });
    await renderRoute('/app/interviews/int1/complete', { api });

    expect(await screen.findByRole('list')).toHaveTextContent('Scoring each skill');
    const view = await screen.findByRole('link', { name: 'View your report' }, { timeout: 5000 });
    expect(view).toHaveAttribute('href', '/app/reports/int1');
    expect(screen.getByRole('link', { name: 'Rate your interview' })).toHaveAttribute(
      'href',
      `/app/reports/int1#${'feedback'}`,
    );
    expect(screen.getByText('Your readiness report is ready.')).toBeInTheDocument();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('reassures the candidate when evaluation is stuck', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'PROCESSING', credit: 'CONSUMED' })),
      'GET /interviews/int1/progress': () => ok(makeProgress({ status: 'FAILED' })),
    });
    await renderRoute('/app/interviews/int1/complete', { api });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This is taking longer than usual — our team has been notified; your answers are saved.',
    );
    expect(
      within(screen.getByRole('list')).getByText('Scoring each skill').closest('li'),
    ).toHaveTextContent('(delayed)');
    expect(screen.queryByRole('button', { name: /try again|retry/i })).not.toBeInTheDocument();
  });

  it('links straight to the report when it is ready', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(makeInterview({ state: 'REPORT_READY', credit: 'CONSUMED' })),
    });
    await renderRoute('/app/interviews/int1/complete', { api });
    expect(await screen.findByRole('link', { name: 'View your report' })).toHaveAttribute(
      'href',
      '/app/reports/int1',
    );
    expect(api.calls.some((c) => c.key === 'GET /interviews/int1/progress')).toBe(false);
  });

  it('says the credit was returned after an early end', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'PROCESSING', credit: 'REFUNDED' })),
    });
    await renderRoute('/app/interviews/int1/complete', { api });
    expect(
      await screen.findByText('Your credit was returned because the interview ended early.'),
    ).toBeInTheDocument();
  });

  it('explains an expired interview', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'EXPIRED', credit: 'CONSUMED' })),
    });
    await renderRoute('/app/interviews/int1/complete', { api });
    expect(
      await screen.findByText('This interview expired after being paused for 24 hours.'),
    ).toBeInTheDocument();
  });

  it('apologises when the interview failed', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(
          makeInterview({
            state: 'FAILED',
            credit: 'REFUNDED',
            startedAt: '2026-09-20T10:01:00.000Z',
          }),
        ),
    });
    await renderRoute('/app/interviews/int1/complete', { api });
    expect(
      await screen.findByRole('heading', { name: 'Sorry, something went wrong' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Your credit was returned.')).toBeInTheDocument();
  });
});

describe('dashboard credits and resume links', () => {
  it('shows available and held credits and links each interview to the right screen', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /credits/balance': balance(2, 1),
      'GET /interviews': () =>
        ok([
          makeInterview({ state: 'ACTIVE', credit: 'RESERVED' }),
          makeInterview({ id: 'int2', title: 'Data Analyst', state: 'READY_TO_START' }),
          makeInterview({
            id: 'int3',
            title: 'QA Engineer',
            state: 'PROCESSING',
            credit: 'CONSUMED',
          }),
          makeInterview({
            id: 'int4',
            title: 'Frontend Developer',
            state: 'REPORT_READY',
            credit: 'CONSUMED',
          }),
        ]),
    });
    await renderRoute('/app', { api });

    const credits = await screen.findByRole('region', { name: 'Credits' });
    expect(await within(credits).findByText('2 credits available')).toBeInTheDocument();
    expect(within(credits).getByText('1 held by an interview in progress')).toBeInTheDocument();

    const recent = screen.getByRole('region', { name: 'Recent interviews' });
    const resume = await within(recent).findByRole('link', { name: 'Resume Backend Developer' });
    expect(resume).toHaveAttribute('href', '/app/interviews/int1/room');
    expect(resume).toHaveTextContent('Resume');
    expect(within(recent).getByText('In progress')).toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'Open Data Analyst' })).toHaveAttribute(
      'href',
      '/app/interviews/int2/start',
    );
    expect(within(recent).getByRole('link', { name: 'Open QA Engineer' })).toHaveAttribute(
      'href',
      '/app/interviews/int3/complete',
    );
    const report = within(recent).getByRole('link', { name: 'View report for Frontend Developer' });
    expect(report).toHaveAttribute('href', '/app/reports/int4');
    expect(report).toHaveTextContent('View report');
  });
});
