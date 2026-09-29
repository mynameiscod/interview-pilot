import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeInterviewCampaign, makePublicCampaign } from '../../test/campaign-fixtures';
import { installFakeMedia } from '../../test/fake-media';
import { makeInterview } from '../../test/interview-fixtures';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('personal invite links', () => {
  it('shows what the company will see and joins through the invite', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /campaign-invites/itok123': () =>
        ok(makePublicCampaign({ employerView: 'SCORES', idCapture: true, inviteOnly: true })),
      'POST /campaign-invites/itok123/join': () => ok({ interviewId: 'int9', created: true }),
      'GET /resumes': () => ok([]),
    });
    const { router } = await renderRoute('/campaign/i/itok123', { api });
    const notices = await screen.findByRole('region', { name: 'Before you join' });
    expect(
      within(notices).getByText(
        'Acme Labs will see your scores (overall and by area), not your answers or report.',
      ),
    ).toBeInTheDocument();
    expect(within(notices).getByText(/you take a selfie and a photo of an ID/)).toBeInTheDocument();
    expect(within(notices).getByText(/Only invited candidates can join/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Join interview' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int9/analysis'),
    );
    expect(api.calls.some((c) => c.key === 'POST /campaign-invites/itok123/join')).toBe(true);
    expect(api.calls.some((c) => c.key.startsWith('POST /campaigns/'))).toBe(false);
  });

  it('brings signed-out visitors back to the invite after signing in', async () => {
    const api = fakeApi({ 'GET /campaign-invites/itok123': () => ok(makePublicCampaign()) });
    await renderRoute('/campaign/i/itok123', { api });
    expect(await screen.findByRole('link', { name: 'Join interview' })).toHaveAttribute(
      'href',
      '/login?next=%2Fcampaign%2Fi%2Fitok123',
    );
    // A full report campaign says so too.
    expect(
      screen.getByText('Acme Labs will see your scores, your report and the interview transcript.'),
    ).toBeInTheDocument();
  });

  it('explains an invite-only refusal in the candidate’s language', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /campaigns/tok1': () => ok(makePublicCampaign({ inviteOnly: true })),
      'POST /campaigns/tok1/join': () => fail(403, 'INVITE_REQUIRED'),
      'GET /resumes': () => ok([]),
    });
    await renderRoute('/campaign/tok1', { api, lng: 'hi' });
    await userEvent.click(await screen.findByRole('button', { name: /इंटरव्यू/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('यह इंटरव्यू सिर्फ़ आमंत्रण से है।');
  });
});

describe('identity capture before starting', () => {
  const identity = (selfie: boolean, idDocument: boolean) => ({
    required: true,
    selfie,
    idDocument,
    complete: selfie && idDocument,
  });

  it('keeps the start button disabled until both photos are taken', async () => {
    installFakeMedia();
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      get: () => 640,
      configurable: true,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      get: () => 480,
      configurable: true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
      cb(new Blob(['jpeg'], { type: 'image/jpeg' })),
    );
    const uploads: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        uploads.push({ url, init });
        return new Response(JSON.stringify({ data: identity(true, false) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    let current = identity(false, false);
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(makeInterview({ campaign: makeInterviewCampaign({ identity: current }) })),
      'GET /credits/balance': () => ok({ available: 1, reserved: 0, lots: [] }),
    });
    await renderRoute('/app/interviews/int1/start', { api });

    const card = await screen.findByRole('region', { name: 'Confirm your identity' });
    expect(screen.getByRole('button', { name: 'Start interview' })).toBeDisabled();
    expect(within(card).getByText(/Aadhaar/)).toBeInTheDocument();

    const takeButtons = within(card).getAllByRole('button', { name: 'Take photo' });
    await userEvent.click(takeButtons[0]!);
    expect(await within(card).findByLabelText('Camera preview')).toBeInTheDocument();
    current = identity(true, false);
    await userEvent.click(within(card).getByRole('button', { name: 'Capture' }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]!.url).toMatch(/\/api\/v1\/interviews\/int1\/identity\/selfie$/);
    expect(uploads[0]!.init.method).toBe('PUT');
    expect((uploads[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
    expect(await within(card).findByRole('button', { name: 'Retake' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start interview' })).toBeDisabled();
  });

  it('allows starting once both photos are saved', async () => {
    const api = fakeApi({
      ...signedIn,
      'GET /interviews/int1': () =>
        ok(makeInterview({ campaign: makeInterviewCampaign({ identity: identity(true, true) }) })),
    });
    await renderRoute('/app/interviews/int1/start', { api });
    expect(
      await screen.findByText('Both photos are saved. You can start when you are ready.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start interview' })).toBeEnabled();
  });
});
