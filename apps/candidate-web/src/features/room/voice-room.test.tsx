import type { RtAck, VoiceTranscript } from '@cbi/shared-types';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, makeSession, ok } from '@cbi/web-core/testing';
import { fakeApiWithUploads } from '../../test/fake-api';
import { installFakeMedia, type FakeMedia } from '../../test/fake-media';
import { fakeSocketFactory, makeSnapshot, type FakeSocket } from '../../test/fake-socket';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const ROOM = '/app/interviews/int1/room';
const QUESTION = 'Tell me about a project you are proud of.';

const transcript: VoiceTranscript = {
  transcriptId: '6f1c2a4e-1d2b-4c3a-9e8f-0a1b2c3d4e5f',
  questionId: 'q1',
  text: 'I built a timetable app for my college.',
  durationSec: 4.2,
  language: 'en',
  lowConfidence: false,
};

type Handlers = Parameters<typeof fakeApiWithUploads>[0];

let fake: FakeMedia;
let clock = 0;
let audioFetch: ReturnType<typeof vi.fn>;

/** Question audio is fetched with the access token (not through the JSON client). */
function stubAudio(reply: () => Response = () => new Response('mp3-bytes', { status: 200 })) {
  audioFetch = vi.fn(async (url: string) => {
    if (url.includes('/questions/') && url.endsWith('/audio')) return reply();
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', audioFetch);
}

async function openVoiceRoom(
  opts: { handlers?: Handlers; setup?: (socket: FakeSocket) => void } = {},
) {
  const sockets = fakeSocketFactory({
    setup: (socket) => {
      socket.ackHandlers['interview:join'] = () => ({
        ok: true,
        snapshot: makeSnapshot({ mode: 'VOICE', voiceEnabled: true }),
      });
      opts.setup?.(socket);
    },
  });
  const api = fakeApiWithUploads({ ...signedIn, ...opts.handlers });
  const result = await renderRoute(ROOM, { api, socketFactory: sockets.factory });
  return { ...result, sockets };
}

/** Records an answer of `ms` milliseconds (the recorder's clock is performance.now). */
async function recordAnswer(user: ReturnType<typeof userEvent.setup>, ms = 4_200) {
  await user.click(await screen.findByRole('button', { name: 'Start answering' }));
  expect(await screen.findByText('Recording')).toBeInTheDocument();
  clock += ms;
  await user.click(screen.getByRole('button', { name: 'Done' }));
}

beforeEach(() => {
  sessionStorage.clear();
  fake = installFakeMedia();
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  stubAudio();
});
afterEach(() => {
  // Unmount while the fakes are still installed: the room releases its media on unmount.
  cleanup();
  fake.uninstall();
  vi.restoreAllMocks();
});

describe('voice interview room', () => {
  it('reads the question aloud, records an answer, shows the transcript and submits it', async () => {
    let release!: (ack: RtAck) => void;
    const { api, sockets } = await openVoiceRoom({
      handlers: { 'POST /interviews/int1/voice/transcribe': () => ok(transcript) },
      setup: (socket) => {
        socket.ackHandlers['answer:text'] = () => new Promise<RtAck>((r) => (release = r));
      },
    });
    const user = userEvent.setup();

    // The question plays with a speaking indicator; its text stays as captions.
    expect(await screen.findByText('Speaking…')).toBeInTheDocument();
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    const [url, init] = audioFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/interviews\/int1\/questions\/q1\/audio$/);
    expect(init.headers).toEqual({ Authorization: 'Bearer access-token' });
    expect(fake.play).toHaveBeenCalledTimes(1);
    const audio = fake.media.played[0]!;
    expect(audio.src).toBe('blob:test/1');

    await act(async () => audio.dispatchEvent(new Event('ended')));
    expect(screen.queryByText('Speaking…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Repeat question' }));
    expect(fake.play).toHaveBeenCalledTimes(2);
    // The cached audio is replayed, not downloaded again.
    expect(audioFetch).toHaveBeenCalledTimes(1);

    // Starting to answer stops the question audio.
    const pausesBefore = fake.pause.mock.calls.length;
    await recordAnswer(user);
    expect(fake.pause.mock.calls.length).toBeGreaterThan(pausesBefore);
    expect(fake.media.recorders[0]!.mimeType).toBe('audio/webm;codecs=opus');
    expect(fake.media.recorders[0]!.timeslice).toBe(1000);

    expect(await screen.findByRole('heading', { name: "Here's what we heard" })).toHaveFocus();
    expect(screen.getByText(transcript.text)).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /interviews/int1/voice/transcribe')!.body).toEqual(
      { questionId: 'q1', durationMs: '4200', audio: { name: 'answer.webm' } },
    );
    // The microphone is released once recording stops.
    expect(fake.media.tracks.every((t) => t.stopped)).toBe(true);
    expect(fake.media.contexts.every((c) => c.closed)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Submit answer' }));
    const [sent] = sockets.last.sent('answer:text') as [Record<string, unknown>];
    expect(sent).toMatchObject({
      sessionId: 'int1',
      questionId: 'q1',
      text: transcript.text,
      voiceTranscriptId: transcript.transcriptId,
    });
    expect(sent.clientMsgId).toEqual(expect.any(String));

    await act(async () => release({ ok: true }));
    expect(await screen.findByText('Preparing the next question…')).toBeInTheDocument();
    // The question's audio is released once it is answered.
    expect(fake.media.revoked).toEqual(['blob:test/1']);
  });

  it('suggests recording again when the transcript is unclear', async () => {
    await openVoiceRoom({
      handlers: {
        'POST /interviews/int1/voice/transcribe': () =>
          ok({ ...transcript, text: '', lowConfidence: true }),
      },
    });
    const user = userEvent.setup();
    await recordAnswer(user);

    expect(await screen.findByText('We did not catch any words.')).toBeInTheDocument();
    expect(screen.getByText(/record again if it is wrong/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit answer' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Record again' }));
    expect(await screen.findByText('Recording')).toBeInTheDocument();
    expect(fake.media.recorders).toHaveLength(2);
  });

  it('offers typing when speech recognition is unavailable', async () => {
    const { api } = await openVoiceRoom({
      handlers: {
        'POST /interviews/int1/voice/transcribe': () => fail(503, 'SPEECH_UNAVAILABLE'),
        'POST /interviews/int1/mode': () => ok({ mode: 'TEXT' }),
      },
    });
    const user = userEvent.setup();
    await recordAnswer(user);

    expect(
      await screen.findByText('We cannot turn speech into text right now'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch to typing' }));

    expect(await screen.findByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /interviews/int1/mode')!.body).toEqual({
      mode: 'TEXT',
      reason: 'STT_UNAVAILABLE',
    });
    expect(screen.getByRole('button', { name: 'Answer by voice' })).toBeInTheDocument();
  });

  it('retries the same recording after a speech outage', async () => {
    let attempts = 0;
    const { api } = await openVoiceRoom({
      handlers: {
        'POST /interviews/int1/voice/transcribe': () =>
          attempts++ === 0 ? fail(503, 'SPEECH_UNAVAILABLE') : ok(transcript),
      },
    });
    const user = userEvent.setup();
    await recordAnswer(user);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(transcript.text)).toBeInTheDocument();
    expect(
      api.calls.filter((c) => c.key === 'POST /interviews/int1/voice/transcribe'),
    ).toHaveLength(2);
  });

  it('switches to the text answer box when the server changes the mode', async () => {
    const { sockets } = await openVoiceRoom();
    const user = userEvent.setup();
    await screen.findByText('Speaking…');
    await user.click(screen.getByRole('button', { name: 'Start answering' }));
    expect(await screen.findByText('Recording')).toBeInTheDocument();

    await sockets.last.push('interview:mode', { mode: 'TEXT', reason: 'CANDIDATE_CHOICE' });

    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start answering' })).not.toBeInTheDocument();
    expect(screen.queryByText('Recording')).not.toBeInTheDocument();
    // Recording and playback stop, and the microphone is released.
    expect(fake.media.recorders[0]!.state).toBe('inactive');
    expect(fake.media.tracks.every((t) => t.stopped)).toBe(true);
    expect(fake.media.revoked).toEqual(['blob:test/1']);
    expect(screen.getByText('You are now answering by typing.')).toBeInTheDocument();
  });

  it('lets the candidate type instead', async () => {
    const { api } = await openVoiceRoom({
      handlers: { 'POST /interviews/int1/mode': () => ok({ mode: 'TEXT' }) },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Type instead' }));
    expect(await screen.findByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /interviews/int1/mode')!.body).toEqual({
      mode: 'TEXT',
      reason: 'CANDIDATE_CHOICE',
    });
  });

  it('shows a Play button when the browser blocks autoplay', async () => {
    fake.uninstall();
    fake = installFakeMedia({ playRejects: true });
    stubAudio();
    await openVoiceRoom();
    expect(await screen.findByRole('button', { name: 'Play question' })).toBeInTheDocument();
    expect(
      screen.getByText('Your browser did not let the question play by itself.'),
    ).toBeInTheDocument();
  });

  it('offers to continue on screen when questions cannot be read aloud', async () => {
    stubAudio(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'SPEECH_UNAVAILABLE', message: 'down', requestId: 't' },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    await openVoiceRoom();
    const user = userEvent.setup();

    expect(
      await screen.findByText("Questions can't be read aloud right now — read them on screen"),
    ).toBeInTheDocument();
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      screen.queryByText("Questions can't be read aloud right now — read them on screen"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start answering' })).toBeEnabled();
  });

  it('marks spoken answers in the transcript with a microphone', async () => {
    const { sockets } = await openVoiceRoom({
      setup: (socket) => {
        socket.ackHandlers['interview:join'] = () => ({
          ok: true,
          snapshot: makeSnapshot({
            mode: 'VOICE',
            voiceEnabled: true,
            currentQuestion: null,
            thinking: true,
            lastSeq: 1,
            turns: [
              {
                seq: 1,
                questionId: 'q1',
                roundIdx: 0,
                question: QUESTION,
                answer: 'A timetable app.',
                answerSource: 'VOICE',
              },
            ],
          }),
        });
      },
    });
    const user = userEvent.setup();
    await waitFor(() => expect(sockets.last.sent('interview:join')).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: /Transcript \(1 question\)/ }));
    expect(screen.getByText('(spoken answer)', { exact: false })).toBeInTheDocument();
  });
});
