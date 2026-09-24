import type { DeviceCheckBody, VoiceReadiness } from '@cbi/shared-types';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { decide, makeConsentItem, makeConsents } from '../../test/consent-fixtures';
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
    let consents = makeConsents([makeConsentItem('VOICE_PROCESSING')]);
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(makeInterview({ mode: 'VOICE', voice, consentsPending: !consents.complete })),
      'GET /voice/health': () => ok({ stt: 'AVAILABLE', tts: 'DEGRADED' }),
      'POST /interviews/int1/device-check': (body) => {
        voice = {
          deviceCheck: { ...(body as DeviceCheckBody), at: AT, passed: true },
          consentsComplete: false,
          recording: false,
          ready: false,
        };
        return ok(voice);
      },
      'GET /interviews/int1/consents': () => ok(consents),
      'POST /interviews/int1/consents': (body) => {
        consents = decide(consents, body);
        voice = { ...voice!, consentsComplete: consents.complete, ready: consents.complete };
        return ok(consents);
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
      await screen.findByRole('heading', { name: 'Your choices for this interview' }),
    ).toBeInTheDocument();
    // The notice text comes from the server, one paragraph per blank-line block.
    expect(screen.getByText('Your audio is not stored.')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    const posted = api.calls.find((c) => c.key === 'POST /interviews/int1/device-check')!
      .body as DeviceCheckBody;
    expect(posted).toMatchObject({
      microphone: 'PASS',
      recorder: 'PASS',
      speaker: 'PASS',
      network: 'PASS',
      speechService: 'PASS',
      mimeType: 'audio/webm;codecs=opus',
      camera: null,
      videoMimeType: null,
    });
    expect(posted.rttMs).toEqual(expect.any(Number));

    expect(screen.getByRole('button', { name: 'Save my choices' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'I agree' }));
    await user.click(screen.getByRole('button', { name: 'Save my choices' }));
    expect(await screen.findByRole('heading', { name: 'You are ready' })).toHaveFocus();
    expect(api.calls.find((c) => c.key === 'POST /interviews/int1/consents')!.body).toEqual({
      decisions: [{ consentTextId: 'ct-voice_processing', accepted: true }],
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

describe('video device check', () => {
  const VIDEO_CHECK = '/app/interviews/int1/device-check';

  function videoApi(extra: Parameters<typeof fakeApi>[0] = {}) {
    return fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(
          makeInterview({
            mode: 'VIDEO',
            consentsPending: true,
            template: {
              id: 'tpl1',
              name: 'Standard practice',
              creditCost: 1,
              modes: ['TEXT', 'VOICE', 'VIDEO'],
              totalDurationSec: 1800,
            },
          }),
        ),
      'GET /voice/health': () => ok({ stt: 'AVAILABLE', tts: 'AVAILABLE' }),
      'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
      ...extra,
    });
  }

  it('explains a blocked camera and how to allow it', async () => {
    fake = installFakeMedia({
      cameraError: new DOMException('Permission denied', 'NotAllowedError'),
    });
    await renderRoute(VIDEO_CHECK, { api: videoApi() });
    const user = userEvent.setup();

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Check your camera, microphone and speaker',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Test camera' }));
    const camera = checkItem('Camera');
    expect(await within(camera).findByText('Failed')).toBeInTheDocument();
    expect(within(camera).getByText(/Camera access is blocked/)).toBeInTheDocument();
    expect(within(camera).getByRole('button', { name: 'Test again' })).toBeInTheDocument();
    expect(fake.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.anything(), audio: expect.anything() }),
    );

    // Everything else passes, but a failed camera still blocks a video interview.
    await user.click(screen.getByRole('button', { name: 'Test microphone' }));
    await screen.findByText('We can hear you clearly.');
    await user.click(screen.getByRole('button', { name: 'Play test sound' }));
    await user.click(screen.getByRole('button', { name: 'Yes, I heard it' }));
    await screen.findByText(/Your connection is good/);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /camera, microphone or browser cannot be used for a video interview/,
    );
  });

  it('shows the camera, posts the camera result and video format, then asks for consent', async () => {
    fake = installFakeMedia();
    let consents = makeConsents([
      makeConsentItem('VOICE_PROCESSING'),
      makeConsentItem('RECORDING'),
    ]);
    const api = videoApi({
      'POST /interviews/int1/device-check': (body) =>
        ok({
          deviceCheck: { ...(body as DeviceCheckBody), at: AT, passed: true },
          consentsComplete: false,
          recording: false,
          ready: false,
        } satisfies VoiceReadiness),
      'GET /interviews/int1/consents': () => ok(consents),
      'POST /interviews/int1/consents': (body) => {
        consents = decide(consents, body);
        return ok(consents);
      },
    });
    await renderRoute(VIDEO_CHECK, { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Test camera' }));
    expect(await within(checkItem('Camera')).findByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Your camera works.')).toBeInTheDocument();
    const preview = screen.getByLabelText('Your camera preview') as HTMLVideoElement;
    expect(preview).toBeVisible();
    expect(preview.muted).toBe(true);
    expect(within(checkItem('Browser')).getByText(/can record video/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Test microphone' }));
    await screen.findByText('We can hear you clearly.');
    await user.click(screen.getByRole('button', { name: 'Play test sound' }));
    await user.click(screen.getByRole('button', { name: 'Yes, I heard it' }));
    await screen.findByText(/Your connection is good/);
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));

    const posted = api.calls.find((c) => c.key === 'POST /interviews/int1/device-check')!
      .body as DeviceCheckBody;
    expect(posted).toMatchObject({
      microphone: 'PASS',
      recorder: 'PASS',
      camera: 'PASS',
      videoMimeType: 'video/webm;codecs=vp9,opus',
      mimeType: 'audio/webm;codecs=opus',
    });
    // The camera is released once the check is saved.
    expect(fake.media.tracks.every((t) => t.stopped)).toBe(true);

    await screen.findByRole('heading', { name: 'Your choices for this interview' });
    const recording = screen.getByRole('group', { name: /Recording/ });
    expect(within(recording).getByText('Optional')).toBeInTheDocument();
    expect(within(recording).getByText(/You can delete the recording at any time/)).toBeVisible();
    await user.click(
      within(recording).getByRole('radio', { name: 'Do not record this interview' }),
    );
    const voice = screen.getByRole('group', { name: /Voice processing/ });
    await user.click(within(voice).getByRole('radio', { name: 'I agree' }));
    await user.click(screen.getByRole('button', { name: 'Save my choices' }));

    expect(await screen.findByRole('heading', { name: 'You are ready' })).toBeInTheDocument();
    expect(screen.getByText(/Your camera, microphone and speaker are checked/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /interviews/int1/consents')!.body).toEqual({
      decisions: [
        { consentTextId: 'ct-voice_processing', accepted: true },
        { consentTextId: 'ct-recording', accepted: false },
      ],
    });
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
