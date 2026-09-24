import type { InterviewSummary, SessionConsents, UserConsentEntry } from '@cbi/shared-types';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { decide, makeConsentItem, makeConsents } from '../../test/consent-fixtures';
import { makeInterview } from '../../test/interview-fixtures';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const AT = '2026-09-24T10:00:00.000Z';
const START = '/app/interviews/int1/start';

/** A fake API whose interview follows the consents the candidate records. */
function consentApi(
  initial: SessionConsents,
  interview: (consents: SessionConsents) => InterviewSummary,
) {
  let consents = initial;
  const api = fakeApi({
    ...signedIn,
    'GET /interviews/int1': () => ok(interview(consents)),
    'GET /interviews/int1/consents': () => ok(consents),
    'POST /interviews/int1/consents': (body) => {
      consents = decide(consents, body);
      return ok(consents);
    },
    'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
  });
  return api;
}

describe('consent step', () => {
  it('asks a text interview with session observations for consent; a required decline blocks the start', async () => {
    const api = consentApi(makeConsents([makeConsentItem('INTEGRITY')]), (consents) =>
      makeInterview({ consentsPending: !consents.complete }),
    );
    const { router } = await renderRoute(START, { api });
    const user = userEvent.setup();

    expect(await screen.findByRole('button', { name: 'Start interview' })).toBeDisabled();
    await user.click(screen.getByRole('link', { name: 'Review and make choices' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int1/consent'),
    );

    const item = await screen.findByRole('group', { name: /Session observations/ });
    expect(within(item).getByText('Required')).toBeInTheDocument();
    expect(
      within(item).getByText('Tab switches, focus changes and pastes are noted.'),
    ).toBeVisible();
    expect(within(item).getByText('They are observations, never judgements.')).toBeVisible();

    await user.click(within(item).getByRole('radio', { name: 'I do not agree' }));
    expect(within(item).getByText(/cannot start unless you agree/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save my choices' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /did not agree to a required notice, so this interview cannot start/,
    );
    expect(api.calls.find((c) => c.key === 'POST /interviews/int1/consents')!.body).toEqual({
      decisions: [{ consentTextId: 'ct-integrity', accepted: false }],
    });
    // Still on the consent step: declining is recorded but does not move on.
    expect(router.state.location.pathname).toBe('/app/interviews/int1/consent');

    await user.click(within(item).getByRole('radio', { name: 'I agree' }));
    await user.click(screen.getByRole('button', { name: 'Save my choices' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(START));
    expect(await screen.findByRole('button', { name: 'Start interview' })).toBeEnabled();
  });

  it('lets a video interview start without recording when optional recording is declined', async () => {
    const deviceCheck = {
      microphone: 'PASS',
      recorder: 'PASS',
      speaker: 'PASS',
      network: 'PASS',
      speechService: 'PASS',
      camera: 'PASS',
      mimeType: 'audio/webm;codecs=opus',
      videoMimeType: 'video/webm;codecs=vp9,opus',
      rttMs: 40,
      browser: 'Chrome 140',
      at: AT,
      passed: true,
    } as const;
    const api = consentApi(
      makeConsents([makeConsentItem('VOICE_PROCESSING'), makeConsentItem('RECORDING')]),
      (consents) =>
        makeInterview({
          mode: 'VIDEO',
          consentsPending: !consents.complete,
          voice: {
            deviceCheck,
            consentsComplete: consents.complete,
            recording: consents.items.some((i) => i.type === 'RECORDING' && i.decision?.accepted),
            ready: consents.complete,
          },
        }),
    );
    const { router } = await renderRoute(START, { api });
    const user = userEvent.setup();

    expect(await screen.findByRole('button', { name: 'Start interview' })).toBeDisabled();
    // The device check passed: only the consents are missing.
    await user.click(screen.getByRole('link', { name: 'Review and make choices' }));

    const recording = await screen.findByRole('group', { name: /Recording/ });
    expect(within(recording).getByText('Optional')).toBeInTheDocument();
    expect(within(recording).getByText(/runs normally without a recording/)).toBeInTheDocument();
    await user.click(
      within(recording).getByRole('radio', { name: 'Do not record this interview' }),
    );
    const voice = screen.getByRole('group', { name: /Voice processing/ });
    await user.click(within(voice).getByRole('radio', { name: 'I agree' }));
    await user.click(screen.getByRole('button', { name: 'Save my choices' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(START));
    expect(await screen.findByRole('button', { name: 'Start interview' })).toBeEnabled();
    expect(screen.getByText('This interview will not be recorded.')).toBeInTheDocument();
    expect(screen.getByText(/This is a video interview/)).toBeInTheDocument();
  });

  it('lists the consent history on the profile page', async () => {
    const history: UserConsentEntry[] = [
      {
        id: 'c1',
        type: 'VOICE_PROCESSING',
        version: 2,
        locale: 'en',
        title: 'Voice processing',
        accepted: true,
        at: '2026-09-20T10:00:00.000Z',
        sessionId: 'int1',
      },
      {
        id: 'c2',
        type: 'RECORDING',
        version: 1,
        locale: 'en',
        title: 'Recording',
        accepted: false,
        at: '2026-09-21T10:00:00.000Z',
        sessionId: 'int1',
      },
    ];
    const api = fakeApi({ ...signedIn, 'GET /users/me/consents': () => ok(history) });
    await renderRoute('/app/profile', { api });

    const section = await screen.findByRole('region', { name: 'Consent history' });
    const rows = await within(section).findAllByRole('listitem');
    // Newest first.
    expect(rows[0]).toHaveTextContent('Recording');
    expect(rows[0]).toHaveTextContent('Declined');
    expect(rows[0]).toHaveTextContent('version 1');
    expect(rows[1]).toHaveTextContent('Voice processing');
    expect(rows[1]).toHaveTextContent('Agreed');
  });
});
