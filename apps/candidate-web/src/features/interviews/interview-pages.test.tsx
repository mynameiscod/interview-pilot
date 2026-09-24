import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { makeInterview } from '../../test/interview-fixtures';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };

describe('role analysis page', () => {
  it('shows the detected role, skills, rounds and next steps', async () => {
    const api = fakeApi({ ...signedIn, 'GET /interviews/int1': () => ok(makeInterview()) });
    await renderRoute('/app/interviews/int1/analysis', { api });

    expect(await screen.findByRole('heading', { name: 'Backend Developer' })).toBeInTheDocument();
    expect(screen.getByText('Level: Junior')).toBeInTheDocument();
    expect(screen.getByText('High confidence')).toBeInTheDocument();
    expect(screen.getByText('Tailored to your job description')).toBeInTheDocument();
    expect(screen.getByText('Matches our role: Backend Developer')).toBeInTheDocument();
    expect(screen.getByText('Company: Acme Labs')).toBeInTheDocument();

    const skills = screen.getByRole('region', { name: 'Skills we will focus on' });
    expect(within(skills).getByText('Importance 40/100')).toBeInTheDocument();
    expect(within(skills).getAllByText('Job description')).toHaveLength(2);
    expect(within(skills).getByText('Not shown in your resume')).toBeInTheDocument();

    const rounds = screen.getByRole('region', { name: 'Planned rounds' });
    expect(within(rounds).getByText('Total: about 25 minutes')).toBeInTheDocument();
    expect(within(rounds).getByText('Focus: Node.js, SQL')).toBeInTheDocument();
    expect(screen.getByText('Built a REST API used by 2,000 students')).toBeInTheDocument();
    expect(screen.getByText('No production database experience shown')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Looks right — continue' })).toHaveAttribute(
      'href',
      '/app/interviews/int1/setup',
    );
    expect(screen.getByRole('link', { name: 'Edit inputs' })).toHaveAttribute(
      'href',
      '/app/new?edit=int1',
    );
  });

  it('shows progress while the analysis runs', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'ROLE_ANALYSIS', analysis: null })),
    });
    await renderRoute('/app/interviews/int1/analysis', { api });
    expect(
      await screen.findByRole('heading', { name: 'Analysing your interview' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reading your inputs');
    expect(screen.getByText(/can take up to a minute/)).toBeInTheDocument();
  });

  it('explains a failure and retries the analysis', async () => {
    const failed = makeInterview({
      state: 'FAILED',
      analysis: null,
      failure: { code: 'AI_UNAVAILABLE', at: '2026-09-20T10:01:00.000Z' },
    });
    const analysing = makeInterview({ state: 'ROLE_ANALYSIS', analysis: null });
    let current = failed;
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(current),
      'POST /interviews/int1/analyze': () => {
        current = analysing;
        return { status: 202, body: { data: analysing } };
      },
    });
    await renderRoute('/app/interviews/int1/analysis', { api });
    const user = userEvent.setup();

    expect(
      await screen.findByText(
        'Our analysis service is busy right now. Please try again in a few minutes.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit inputs' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Analysing your interview' }),
    ).toBeInTheDocument();
    expect(api.calls.filter((c) => c.key === 'POST /interviews/int1/analyze')).toHaveLength(1);
  });

  it('does not offer a retry when an input could not be read', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(
          makeInterview({
            state: 'FAILED',
            analysis: null,
            failure: { code: 'INPUT_FAILED', at: '2026-09-20T10:01:00.000Z' },
          }),
        ),
    });
    await renderRoute('/app/interviews/int1/analysis', { api });
    expect(await screen.findByText(/could not read your resume or job description/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('interview setup page', () => {
  it('only allows available modes and saves mode and language', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview()),
      'PATCH /interviews/int1/setup': (body) =>
        ok(makeInterview({ ...(body as object), language: 'hi' })),
    });
    await renderRoute('/app/interviews/int1/setup', { api });
    const user = userEvent.setup();

    expect(await screen.findByRole('radio', { name: 'Text' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Voice' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Video' })).toBeDisabled();
    expect(screen.getAllByText('Not offered for this interview')).toHaveLength(1);
    expect(screen.queryByText('How a voice interview works')).not.toBeInTheDocument();
    expect(screen.getByText('Uses 1 credit')).toBeInTheDocument();
    expect(screen.getByText('25 minutes')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Hindi' }));
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(
      await screen.findByRole('heading', { name: 'Your interview is ready' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      '/app/interviews/int1/start',
    );
    expect(screen.getByRole('button', { name: 'Cancel interview' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'PATCH /interviews/int1/setup')!.body).toEqual({
      mode: 'TEXT',
      language: 'hi',
    });
  });

  it('explains video interviews and continues to the camera check', async () => {
    const template = {
      id: 'tpl1',
      name: 'Standard practice',
      creditCost: 1,
      modes: ['TEXT', 'VOICE', 'VIDEO'] as const,
      totalDurationSec: 1800,
    };
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(makeInterview({ template: { ...template, modes: [...template.modes] } })),
      'PATCH /interviews/int1/setup': (body) =>
        ok(
          makeInterview({
            ...(body as object),
            template: { ...template, modes: [...template.modes] },
            consentsPending: true,
          }),
        ),
    });
    await renderRoute('/app/interviews/int1/setup', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('radio', { name: 'Video' }));
    expect(screen.getByText('How a video interview works')).toBeInTheDocument();
    expect(screen.getByText(/you see yourself in a small window/)).toBeInTheDocument();
    expect(screen.getByText(/recorded only if you agree/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(
      await screen.findByText(/check your camera, microphone and speaker/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      '/app/interviews/int1/device-check',
    );
  });

  it('cancels the interview after an in-page confirmation', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview()),
      'POST /interviews/int1/cancel': () => ok(makeInterview({ state: 'CANCELLED' })),
      'GET /interviews': () => ok([makeInterview({ state: 'CANCELLED' })]),
    });
    const { router } = await renderRoute('/app/interviews/int1/setup', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Cancel interview' }));
    expect(api.calls.some((c) => c.key === 'POST /interviews/int1/cancel')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Yes, cancel it' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app'));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('sends interviews that are still being analysed back to the analysis', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ state: 'ROLE_ANALYSIS', analysis: null })),
    });
    const { router } = await renderRoute('/app/interviews/int1/setup', { api });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int1/analysis'),
    );
  });
});

describe('dashboard', () => {
  it('starts a new interview and lists recent ones', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews': () =>
        ok([
          makeInterview(),
          makeInterview({
            id: 'int2',
            state: 'ROLE_ANALYSIS',
            title: 'Data Analyst',
            companyName: null,
            analysis: null,
          }),
        ]),
    });
    await renderRoute('/app', { api });

    expect(await screen.findByRole('link', { name: 'Start an interview' })).toHaveAttribute(
      'href',
      '/app/new',
    );
    const recent = screen.getByRole('region', { name: 'Recent interviews' });
    expect(await within(recent).findByText('Ready to set up')).toBeInTheDocument();
    expect(within(recent).getByText('Analysing')).toBeInTheDocument();
    expect(within(recent).getByText(/Acme Labs/)).toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'Open Backend Developer' })).toHaveAttribute(
      'href',
      '/app/interviews/int1/setup',
    );
    expect(within(recent).getByRole('link', { name: 'Open Data Analyst' })).toHaveAttribute(
      'href',
      '/app/interviews/int2/analysis',
    );
  });
});
