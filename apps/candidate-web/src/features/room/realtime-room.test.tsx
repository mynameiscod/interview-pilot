import { RtEvent, type RtAck } from '@cbi/shared-types';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession, ok } from '@cbi/web-core/testing';
import { fakeApiWithUploads } from '../../test/fake-api';
import { installFakeMedia, type FakeMedia } from '../../test/fake-media';
import {
  fakeSocketFactory,
  makeQuestion,
  makeSnapshot,
  type FakeSocket,
} from '../../test/fake-socket';
import { renderRoute } from '../../test/render';
import type * as StreamPlayerModule from '../voice/stream-player';

const support = vi.hoisted(() => ({ realtime: true }));

// jsdom has no AudioWorklet: the browser check and the microphone tap are stood in for.
vi.mock('../voice/stream-player', async (importOriginal) => ({
  ...(await importOriginal<typeof StreamPlayerModule>()),
  realtimeVoiceSupported: () => support.realtime,
}));
vi.mock('../voice/pcm-capture', () => ({
  openPcmCapture: async () => ({ close: () => undefined }),
}));

const ROOM = '/app/interviews/int1/room';
const STREAM = '6f1c2f7e-2b0a-4f47-8f0c-3c1d2e4f5a6b';
const TRANSCRIPT = '0b8f6a4e-3b3c-4b8e-9a51-2f4a5c3c1d10';

let fake: FakeMedia;
let audioFetch: ReturnType<typeof vi.fn>;

async function openRoom(flags: Record<string, boolean>, setup?: (socket: FakeSocket) => void) {
  const sockets = fakeSocketFactory({
    setup: (socket) => {
      socket.ackHandlers[RtEvent.JOIN] = () => ({
        ok: true,
        snapshot: makeSnapshot({ mode: 'VOICE', voiceEnabled: true }),
      });
      socket.ackHandlers[RtEvent.VOICE_STREAM_START] = () => ({
        ok: true,
        stream: { streamId: STREAM, resumedText: '', graceMs: 2000 },
      });
      socket.ackHandlers[RtEvent.VOICE_STREAM_STOP] = () => ({ ok: true });
      socket.ackHandlers[RtEvent.ANSWER_TEXT] = () => ({ ok: true }) as RtAck;
      setup?.(socket);
    },
  });
  const api = fakeApiWithUploads({
    'POST /auth/refresh': () => ok(makeSession()),
    'GET /flags': () => ok(flags),
  });
  const result = await renderRoute(ROOM, { api, socketFactory: sockets.factory });
  return { ...result, sockets };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  support.realtime = true;
  fake = installFakeMedia();
  audioFetch = vi.fn(async (url: string) =>
    url.endsWith('/audio')
      ? new Response('mp3-bytes', { status: 200 })
      : new Response(null, { status: 404 }),
  );
  vi.stubGlobal('fetch', audioFetch);
});
afterEach(() => {
  cleanup();
  fake.uninstall();
  vi.restoreAllMocks();
});

describe('realtime voice room', () => {
  it('streams the answer, counts down and sends it; the next question appears as it is written', async () => {
    const { sockets } = await openRoom({ 'voice.realtime': true });
    const user = userEvent.setup();
    // The first question was not streamed to this tab: it is fetched and read as before.
    expect(await screen.findByText('Speaking…')).toBeInTheDocument();
    expect(screen.getByText(/start speaking whenever you are ready/i)).toBeInTheDocument();
    await act(async () => fake.media.played[0]!.dispatchEvent(new Event('ended')));

    // Listening: the stream opens for the current question.
    expect(await screen.findByText('Listening… just speak your answer')).toBeInTheDocument();
    const socket = sockets.last;
    await waitFor(() => expect(socket.sent(RtEvent.VOICE_STREAM_START)).toHaveLength(1));
    await socket.push(RtEvent.VOICE_TRANSCRIPT, {
      streamId: STREAM,
      questionId: 'q1',
      text: 'I built a timetable app',
      interim: 'for my college',
    });
    expect(screen.getByText(/I built a timetable app/)).toBeInTheDocument();
    await socket.push(RtEvent.VOICE_TURN_END, {
      streamId: STREAM,
      questionId: 'q1',
      transcriptId: TRANSCRIPT,
      text: 'I built a timetable app for my college.',
      reason: 'silence',
      graceMs: 2000,
      lowConfidence: false,
    });
    expect(await screen.findByText(/Sending in 2 s/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(socket.sent(RtEvent.ANSWER_TEXT)).toHaveLength(1));
    expect(socket.sent(RtEvent.ANSWER_TEXT)[0]).toMatchObject({
      questionId: 'q1',
      voiceTranscriptId: TRANSCRIPT,
      clientMsgId: `rt-${TRANSCRIPT}`,
    });
    await waitFor(() =>
      expect(socket.sent(RtEvent.VOICE_STREAM_STOP)).toContainEqual({
        streamId: STREAM,
        action: 'close',
      }),
    );

    // The next question streams in: shown as it is written, not fetched as a whole.
    await socket.push(RtEvent.THINKING, { sessionId: 'int1' });
    await socket.push(RtEvent.QUESTION_DELTA, { questionId: 'q2', seq: 2, text: 'How did you ' });
    await socket.push(RtEvent.QUESTION_DELTA, { questionId: 'q2', seq: 2, text: 'test it?' });
    expect(screen.getByText('How did you test it?')).toBeInTheDocument();
    const next = makeQuestion({ questionId: 'q2', seq: 2, text: 'How did you test it?' });
    await socket.push(RtEvent.QUESTION, next);
    expect(document.getElementById('room-question-text')).toHaveTextContent('How did you test it?');
    expect(audioFetch).toHaveBeenCalledTimes(1);
    // Its audio failed to stream: the whole question is fetched instead.
    await socket.push(RtEvent.QUESTION_STREAM_END, { questionId: 'q2', audio: 'failed' });
    await waitFor(() => expect(audioFetch).toHaveBeenCalledTimes(2));
    expect(String(audioFetch.mock.calls[1]![0])).toMatch(/\/questions\/q2\/audio$/);
  });

  it('falls back to push-to-talk when live transcription is not available here', async () => {
    const { sockets } = await openRoom({ 'voice.realtime': true }, (socket) => {
      socket.ackHandlers[RtEvent.VOICE_STREAM_START] = () => ({
        ok: false,
        code: 'UNSUPPORTED',
        message: 'Live transcription does not support this language.',
      });
    });
    expect(await screen.findByText('Speaking…')).toBeInTheDocument();
    await act(async () => fake.media.played[0]!.dispatchEvent(new Event('ended')));
    await waitFor(() => expect(sockets.last.sent(RtEvent.VOICE_STREAM_START)).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'Start answering' })).toBeInTheDocument();
    expect(screen.getByText(/answer with the record button/i)).toBeInTheDocument();
  });

  it('keeps push-to-talk when the flag is off or the browser lacks AudioWorklet', async () => {
    support.realtime = false;
    const first = await openRoom({ 'voice.realtime': true });
    expect(await screen.findByRole('button', { name: 'Start answering' })).toBeInTheDocument();
    expect(first.sockets.last.sent(RtEvent.VOICE_STREAM_START)).toHaveLength(0);
    cleanup();
    support.realtime = true;
    const second = await openRoom({ 'voice.realtime': false });
    expect(await screen.findByRole('button', { name: 'Start answering' })).toBeInTheDocument();
    expect(second.sockets.last.sent(RtEvent.VOICE_STREAM_START)).toHaveLength(0);
  });
});
