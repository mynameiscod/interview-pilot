import type { CampaignClosedReason } from '@cbi/shared-types';
import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeInterviewCampaign, makePublicCampaign } from '../../test/campaign-fixtures';
import { makeConsentItem, makeConsents } from '../../test/consent-fixtures';
import { makeInterview, makeResume } from '../../test/interview-fixtures';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const PAGE = '/campaign/tok1';

describe('campaign landing page', () => {
  it('describes an open, sponsored campaign and sends signed-out visitors to sign in first', async () => {
    const api = fakeApi({
      'GET /campaigns/tok1': () =>
        ok(makePublicCampaign({ sponsored: true, recording: 'REQUIRED', modes: ['VIDEO'] })),
    });
    await renderRoute(PAGE, { api });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Backend hiring 2026' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Interview invitation from Acme Labs')).toBeInTheDocument();
    expect(
      screen.getByText('Acme Labs has invited you to an interview for the Backend Developer role.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Free for you — Acme Labs covers this interview')).toBeInTheDocument();

    const details = screen.getByRole('region', { name: 'About this interview' });
    expect(within(details).getByText('API design')).toBeInTheDocument();
    expect(within(details).getByText('Databases')).toBeInTheDocument();
    expect(within(details).getByText('30 minutes')).toBeInTheDocument();
    expect(within(details).getByText('Video')).toBeInTheDocument();
    expect(within(details).getByText('English, Hindi')).toBeInTheDocument();

    const notices = screen.getByRole('region', { name: 'Before you join' });
    expect(
      within(notices).getByText('Your credits are not used for this interview.'),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText('Your answers and results are shared with Acme Labs.'),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText('You will also get your own readiness report.'),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText(/Video interviews are recorded; you will be asked/),
    ).toBeInTheDocument();
    expect(
      within(notices).getByText(/Tab switches, focus changes and pastes are noted/),
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Join interview' })).toHaveAttribute(
      'href',
      '/login?next=%2Fcampaign%2Ftok1',
    );
  });

  it('says when the company keeps the report and the candidate pays with credits', async () => {
    const api = fakeApi({
      'GET /campaigns/tok1': () =>
        ok(makePublicCampaign({ candidateSeesReport: false, observations: false })),
    });
    await renderRoute(PAGE, { api });

    const notices = await screen.findByRole('region', { name: 'Before you join' });
    expect(
      within(notices).getByText(
        'Acme Labs keeps the report; you will not see a report for this interview.',
      ),
    ).toBeInTheDocument();
    expect(within(notices).getByText('This interview uses your own credits.')).toBeInTheDocument();
    expect(within(notices).getByText('Interviews are not recorded.')).toBeInTheDocument();
    expect(within(notices).queryByText(/Tab switches/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Free for you/)).not.toBeInTheDocument();
  });

  const reasons: [CampaignClosedReason, RegExp][] = [
    ['NOT_STARTED', /This interview opens on .+\. Come back then to join\./],
    ['ENDED', /This interview closed on .+ and is no longer accepting candidates\./],
    ['PAUSED', /Acme Labs has paused this interview for now/],
    ['CLOSED', /This interview is closed and no longer accepting candidates\./],
    ['FULL', /reached its limit of candidates/],
  ];

  it.each(reasons)('explains a %s campaign and offers no way to join', async (reason, text) => {
    const api = fakeApi({
      ...signedIn,
      'GET /campaigns/tok1': () => ok(makePublicCampaign({ closedReason: reason })),
    });
    await renderRoute(PAGE, { api });

    const join = await screen.findByRole('region', { name: 'Join' });
    expect(within(join).getByRole('status')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: 'Join interview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Join interview' })).not.toBeInTheDocument();
  });

  it('links a candidate who already joined to their interview', async () => {
    const campaign = makeInterviewCampaign();
    const api = fakeApi({
      ...signedIn,
      'GET /campaigns/tok1': () => ok(makePublicCampaign({ joinedInterviewId: 'int1' })),
      'GET /interviews/int1': () => ok(makeInterview({ state: 'READY', campaign })),
    });
    await renderRoute(PAGE, { api });

    expect(await screen.findByText('You have already joined this interview.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Continue your interview' })).toHaveAttribute(
        'href',
        '/app/interviews/int1/setup',
      ),
    );
    expect(screen.queryByRole('button', { name: 'Join interview' })).not.toBeInTheDocument();
    // Signed in, the page is loaded with the candidate's token.
    const load = api.calls.find((c) => c.key === 'GET /campaigns/tok1')!;
    expect(JSON.stringify(load.headers)).toContain('Bearer access-token');
  });

  it('joins with a picked resume and opens the new interview', async () => {
    const campaign = makeInterviewCampaign();
    const api = fakeApi({
      ...signedIn,
      'GET /campaigns/tok1': () => ok(makePublicCampaign()),
      'GET /resumes': () => ok([makeResume()]),
      'POST /campaigns/tok1/join': () => ({
        status: 201,
        body: { data: { interviewId: 'int9', created: true } },
      }),
      'GET /interviews/int9': () =>
        ok(makeInterview({ id: 'int9', state: 'ROLE_ANALYSIS', analysis: null, campaign })),
    });
    const { router } = await renderRoute(PAGE, { api });
    const user = userEvent.setup();

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Resume (optional)' }),
      'asha-resume.pdf',
    );
    await user.click(screen.getByRole('button', { name: 'Join interview' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int9/analysis'),
    );
    expect(api.calls.find((c) => c.key === 'POST /campaigns/tok1/join')!.body).toEqual({
      resumeId: 'res1',
    });
    expect(
      await screen.findByRole('heading', { name: 'Analysing your interview' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Company interview' })).toHaveTextContent(
      'Invited by Acme Labs',
    );
  });

  it('refreshes and explains when the campaign closed before joining', async () => {
    let closed = false;
    const api = fakeApi({
      ...signedIn,
      'GET /campaigns/tok1': () =>
        ok(makePublicCampaign({ closedReason: closed ? 'PAUSED' : null })),
      'GET /resumes': () => ok([]),
      'POST /campaigns/tok1/join': () => {
        closed = true;
        return fail(409, 'CAMPAIGN_CLOSED');
      },
    });
    const { router } = await renderRoute(PAGE, { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Join interview' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This interview is not open right now.',
    );
    const join = screen.getByRole('region', { name: 'Join' });
    expect(within(join).getByRole('status')).toHaveTextContent(
      'Acme Labs has paused this interview for now.',
    );
    expect(screen.queryByRole('button', { name: 'Join interview' })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(PAGE);
    expect(api.calls.filter((c) => c.key === 'GET /campaigns/tok1')).toHaveLength(2);
  });

  it('says when an invitation link is not valid', async () => {
    const api = fakeApi({ 'GET /campaigns/tok1': () => fail(404, 'NOT_FOUND') });
    await renderRoute(PAGE, { api });
    expect(
      await screen.findByRole('heading', { name: 'This invitation link is not valid' }),
    ).toBeInTheDocument();
  });
});

describe('campaign interviews', () => {
  it('shows the campaign and only offers its modes and languages at setup', async () => {
    const campaign = makeInterviewCampaign({ modes: ['VOICE'], languages: ['en', 'hi'] });
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ campaign })),
      'PATCH /interviews/int1/setup': (body) =>
        ok(makeInterview({ ...(body as object), campaign })),
    });
    await renderRoute('/app/interviews/int1/setup', { api });
    const user = userEvent.setup();

    const banner = await screen.findByRole('complementary', { name: 'Company interview' });
    expect(banner).toHaveTextContent('Invited by Acme Labs');
    expect(banner).toHaveTextContent('Backend hiring 2026');
    expect(within(banner).getByText('Sponsored')).toBeInTheDocument();

    expect(screen.getByRole('radio', { name: 'Text' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Voice' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Video' })).toBeDisabled();
    expect(screen.queryByRole('radio', { name: 'Auto-detect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Telugu' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked();
    expect(screen.getByText('Sponsored by Acme Labs')).toBeInTheDocument();
    expect(screen.queryByText('Uses 1 credit')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Hindi' }));
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByRole('heading', { name: 'Your interview is ready' });
    expect(api.calls.find((c) => c.key === 'PATCH /interviews/int1/setup')!.body).toEqual({
      mode: 'VOICE',
      language: 'hi',
    });
  });

  it('shows who pays on the start screen and explains a campaign that closed', async () => {
    const campaign = makeInterviewCampaign();
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ campaign })),
      'POST /interviews/int1/start': () => fail(409, 'CAMPAIGN_CLOSED'),
    });
    await renderRoute('/app/interviews/int1/start', { api });
    const user = userEvent.setup();

    const credit = await screen.findByRole('region', { name: 'Credits' });
    expect(credit).toHaveTextContent('Sponsored by Acme Labs');
    expect(credit).toHaveTextContent('Your credits are not used for this interview.');
    expect(api.calls.some((c) => c.key === 'GET /credits/balance')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Start interview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This interview is not open right now.',
    );
  });

  it('asks for consent to share results with the company like any other notice', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(makeInterview({ campaign: makeInterviewCampaign(), consentsPending: true })),
      'GET /interviews/int1/consents': () =>
        ok(makeConsents([makeConsentItem('CAMPAIGN_SHARING')])),
    });
    await renderRoute('/app/interviews/int1/consent', { api });

    const item = await screen.findByRole('group', { name: /Sharing with the company/ });
    expect(within(item).getByText('Required')).toBeInTheDocument();
    expect(
      within(item).getByText(
        'Your answers and report are shared with the company that invited you.',
      ),
    ).toBeVisible();
    expect(within(item).getByRole('radio', { name: 'I agree' })).toBeInTheDocument();
  });

  it('does not link to or load a report the company keeps', async () => {
    const campaign = makeInterviewCampaign({ reportVisible: false });
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(makeInterview({ state: 'REPORT_READY', credit: 'SPONSORED', campaign })),
    });
    await renderRoute('/app/interviews/int1/complete', { api });

    expect(
      await screen.findByText(
        'Your interview has been submitted to Acme Labs. They will contact you about next steps.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Sponsored by Acme Labs — no credits used.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View your report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Rate your interview' })).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.key.includes('/reports'))).toBe(false);
    expect(api.calls.some((c) => c.key === 'GET /interviews/int1/progress')).toBe(false);
  });

  it('lists a campaign interview with a hidden report without a report link', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews': () =>
        ok([
          makeInterview({
            state: 'REPORT_READY',
            credit: 'SPONSORED',
            campaign: makeInterviewCampaign({ reportVisible: false }),
          }),
        ]),
    });
    await renderRoute('/app', { api });

    const recent = await screen.findByRole('region', { name: 'Recent interviews' });
    expect(
      await within(recent).findByText(/submitted to Acme Labs\. They will contact you/),
    ).toBeInTheDocument();
    expect(within(recent).getByText('Invited by Acme Labs')).toBeInTheDocument();
    expect(within(recent).queryByRole('link', { name: /View report/ })).not.toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'Open Backend Developer' })).toHaveAttribute(
      'href',
      '/app/interviews/int1/complete',
    );
  });
});
