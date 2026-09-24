import type { DeviceCheckBody, VoiceReadiness } from '@cbi/shared-types';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { installFakeMedia, type FakeMedia } from '../../test/fake-media';
import { makeInterview } from '../../test/interview-fixtures';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const CHECK = '/app/interviews/int1/device-check';
const AT = '2026-09-24T10:00:00.000Z';

let fake: FakeMedia | null = null;
afterEach(() => {
  // Unmount while the fakes are still installed: the page releases its media on unmount.
  cleanup();
  fake?.uninstall();
  fake = null;
});

/** The list item of one check, found by its heading. */
function checkItem(name: string) {
  return screen.getByRole('heading', { level: 3, name }).closest('li') as HTMLElement;
}

describe('voice device check', () => {
  it('checks the browser, microphone, speaker and connection, then records consent and enables Start', async () => {
    fake = installFakeMedia();
    let voice: VoiceReadiness | null = null;
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ mode: 'VOICE', voice })),
      'GET /voice/health': () => ok({ stt: 'AVAILABLE', tts: 'DEGRADED' }),
      'POST /interviews/int1/device-check': (body) => {
        voice = {
          deviceCheck: { ...(body as DeviceCheckBody), at: AT, passed: true },
          consentAt: null,
          ready: false,
        };
        return ok(voice);
      },
      'POST /interviews/int1/voice-consent': () => {
        voice = { ...voice!, consentAt: AT, ready: true };
        return ok(voice);
      },
      'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
    });
    const { router } = await renderRoute(CHECK, { api });
    const user = userEvent.setup();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check your microphone and speaker' }),
    ).toBeInTheDocument();
    expect(within(checkItem('Browser')).getByText('Passed')).toBeInTheDocument();
    // Connection and speech service are measured with /voice/health; DEGRADED still works.
    expect(await screen.findByText(/Your connection is good/)).toBeInTheDocument();
    expect(await screen.findByText('The speech service is working.')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.key === 'GET /voice/health')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Test microphone' }));
    expect(await screen.findByText('We can hear you clearly.')).toBeInTheDocument();
    expect(within(checkItem('Microphone')).getByText('Passed')).toBeInTheDocument();
    // The microphone is released as soon as it has been heard.
    expect(fake.media.tracks.every((t) => t.stopped)).toBe(true);
    expect(fake.media.contexts[0]!.closed).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Play test sound' }));
    expect(screen.getByText('Did you hear it?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, I heard it' }));
    expect(screen.getByText('Your speaker works.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(
      await screen.findByRole('heading', { name: 'How we use your voice' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Your audio is not stored.')).toBeInTheDocument();
    const posted = api.calls.find((c) => c.key === 'POST /interviews/int1/device-check')!
      .body as DeviceCheckBody;
    expect(posted).toMatchObject({
      microphone: 'PASS',
      recorder: 'PASS',
      speaker: 'PASS',
      network: 'PASS',
      speechService: 'PASS',
      mimeType: 'audio/webm;codecs=opus',
    });
    expect(posted.rttMs).toEqual(expect.any(Number));

    await user.click(screen.getByRole('button', { name: 'I agree' }));
    expect(await screen.findByRole('heading', { name: 'You are ready' })).toHaveFocus();
    expect(api.calls.find((c) => c.key === 'POST /interviews/int1/voice-consent')!.body).toEqual({
      accepted: true,
      version: 'voice-2026-09',
    });

    await user.click(screen.getByRole('link', { name: 'Continue' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/interviews/int1/start'));
    expect(await screen.findByText(/This is a voice interview/)).toBeInTheDocument();
    expect(
      screen.getByText(/Your microphone and speaker are checked and you have agreed/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start interview' })).toBeEnabled();
  });

  it('explains a blocked microphone and offers a text interview instead', async () => {
    fake = installFakeMedia({
      micError: new DOMException('Permission denied', 'NotAllowedError'),
    });
    let interview = makeInterview({ mode: 'VOICE' });
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(interview),
      'GET /voice/health': () => ok({ stt: 'AVAILABLE', tts: 'AVAILABLE' }),
      'PATCH /interviews/int1/setup': (body) => {
        interview = makeInterview(body as object);
        return ok(interview);
      },
      'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
    });
    const { router } = await renderRoute(CHECK, { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Test microphone' }));
    const mic = checkItem('Microphone');
    expect(await within(mic).findByText('Failed')).toBeInTheDocument();
    expect(within(mic).getByText(/Microphone access is blocked/)).toBeInTheDocument();
    expect(within(mic).getByRole('button', { name: 'Test again' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Play test sound' }));
    await user.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByText(/Turn up the volume/)).toBeInTheDocument();
    await screen.findByText(/Your connection is good/);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /cannot record answers right now.*switch to a text interview/,
    );

    await user.click(screen.getByRole('button', { name: 'Switch to a text interview instead' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/interviews/int1/start'));
    expect(api.calls.find((c) => c.key === 'PATCH /interviews/int1/setup')!.body).toEqual({
      mode: 'TEXT',
      language: 'auto',
    });
    expect(await screen.findByText(/This is a text interview/)).toBeInTheDocument();
  });

  it('sends text interviews straight to the start screen', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview()),
      'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
    });
    const { router } = await renderRoute(CHECK, { api });
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/interviews/int1/start'));
  });
});

describe('voice start screen', () => {
  it('asks for the device check before a voice interview can start', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview({ mode: 'VOICE' })),
      'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
    });
    await renderRoute('/app/interviews/int1/start', { api });

    expect(await screen.findByRole('button', { name: 'Start interview' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Check microphone and speaker' })).toHaveAttribute(
      'href',
      CHECK,
    );
  });
});
