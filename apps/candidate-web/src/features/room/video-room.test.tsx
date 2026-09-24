import type { FinalizeMediaBody, IntegrityEventPayload } from '@cbi/shared-types';
import { makeSession, ok } from '@cbi/web-core/testing';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemorySegmentStore, setSegmentStoreForTests } from '../media/segment-store';
import { resetUploadQueues } from '../media/upload-queue';
import { fakeApiWithUploads } from '../../test/fake-api';
import { installFakeMedia, type FakeMedia } from '../../test/fake-media';
import { fakeSocketFactory, makeSnapshot, type FakeSocket } from '../../test/fake-socket';
import { renderRoute } from '../../test/render';
import type { InterviewSnapshot } from '@cbi/shared-types';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const ROOM = '/app/interviews/int1/room';

type Handlers = Parameters<typeof fakeApiWithUploads>[0];

let fake: FakeMedia;
/** Answers for segment uploads, in order (then 201). */
let segmentReplies: number[];
let segmentCalls: { idx: number; init: RequestInit }[];

function stubFetch() {
  segmentCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/audio')) return new Response('mp3-bytes', { status: 200 });
      const m = /\/media\/segments\/(\d+)$/.exec(url);
      if (m) {
        segmentCalls.push({ idx: Number(m[1]), init });
        const status = segmentReplies.shift() ?? 201;
        const body =
          status >= 400
            ? { error: { code: 'PROVIDER_UNAVAILABLE', message: 'x', requestId: 't' } }
            : { data: { index: Number(m[1]), bytes: 1, duplicate: status === 200, received: 1 } };
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 404 });
    }),
  );
}

async function openRoom(
  snapshot: Partial<InterviewSnapshot>,
  opts: { handlers?: Handlers; setup?: (socket: FakeSocket) => void } = {},
) {
  const sockets = fakeSocketFactory({
    setup: (socket) => {
      socket.ackHandlers['interview:join'] = () => ({ ok: true, snapshot: makeSnapshot(snapshot) });
      socket.ackHandlers['integrity:event'] = () => ({ ok: true });
      opts.setup?.(socket);
    },
  });
  const api = fakeApiWithUploads({ ...signedIn, ...opts.handlers });
  const result = await renderRoute(ROOM, { api, socketFactory: sockets.factory });
  return { ...result, sockets };
}

const videoRecorder = () => fake.media.recorders.find((r) => r.mimeType.startsWith('video'));

beforeEach(() => {
  sessionStorage.clear();
  resetUploadQueues();
  setSegmentStoreForTests(createMemorySegmentStore());
  fake = installFakeMedia();
  segmentReplies = [];
  stubFetch();
  // No jitter: the first retry waits 800 ms.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  resetUploadQueues();
  setSegmentStoreForTests(null);
  fake.uninstall();
  vi.restoreAllMocks();
});

describe('video interview room', () => {
  it('shows the self-view, records in 10 s segments and keeps the interview usable while uploads fail', async () => {
    segmentReplies = [503];
    const finalized: FinalizeMediaBody[] = [];
    const { sockets } = await openRoom(
      { mode: 'VIDEO', voiceEnabled: true, recording: true },
      {
        handlers: {
          'POST /interviews/int1/media/finalize': (body) => {
            finalized.push(body as FinalizeMediaBody);
            return ok(null);
          },
        },
      },
    );

    const selfView = await screen.findByRole('complementary', { name: 'Your camera' });
    await waitFor(() => expect(videoRecorder()).toBeDefined());
    const recorder = videoRecorder()!;
    expect(recorder.mimeType).toBe('video/webm;codecs=vp9,opus');
    expect(recorder.timeslice).toBe(10_000);
    expect(await screen.findByText('Recording')).toBeInTheDocument();
    const video = selfView.querySelector('video')!;
    expect(video.muted).toBe(true);
    expect(video).toHaveClass('cb-self-view-mirror');

    // A segment is due; the server is briefly unavailable.
    act(() => recorder.emit('segment-0'));
    await waitFor(() => expect(segmentCalls).toHaveLength(1));
    const first = segmentCalls[0]!;
    expect(first.idx).toBe(0);
    expect(first.init.method).toBe('POST');
    expect(first.init.headers).toMatchObject({
      'Content-Type': 'video/webm',
      Authorization: 'Bearer access-token',
    });
    expect(first.init.body).toBeInstanceOf(Blob);
    expect(await screen.findByText('Saving recording…')).toBeInTheDocument();

    // The interview carries on: answering is not blocked by the upload.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start answering' }));
    expect(await screen.findByRole('button', { name: 'Done' })).toBeEnabled();

    // The retry succeeds after the backoff.
    await waitFor(() => expect(segmentCalls).toHaveLength(2), { timeout: 3_000 });
    await waitFor(() => expect(screen.queryByText('Saving recording…')).not.toBeInTheDocument());

    // The interview ends: the recorder stops, its last chunk is uploaded, then finalize.
    await sockets.last.push(
      'interview:completed',
      makeSnapshot({
        mode: 'VIDEO',
        voiceEnabled: true,
        recording: true,
        state: 'PROCESSING',
        currentQuestion: null,
      }),
    );
    await waitFor(() => expect(finalized).toHaveLength(1));
    expect(segmentCalls.map((c) => c.idx)).toEqual([0, 0, 1]);
    expect(finalized[0]).toEqual({ segmentCount: 2, durationMs: expect.any(Number) });
    expect(recorder.state).toBe('inactive');
  });

  it('resumes segments left over from an earlier page load and continues the numbering', async () => {
    const store = createMemorySegmentStore();
    await store.putMeta({ sessionId: 'int1', nextIdx: 3, durationMs: 30_000, ended: false });
    await store.putSegment({
      sessionId: 'int1',
      idx: 2,
      blob: new Blob(['segment-2'], { type: 'video/webm' }),
      contentType: 'video/webm',
    });
    setSegmentStoreForTests(store);
    await openRoom({ mode: 'VIDEO', voiceEnabled: true, recording: true });

    await waitFor(() => expect(segmentCalls.map((c) => c.idx)).toEqual([2]));
    await waitFor(() => expect(videoRecorder()).toBeDefined());
    act(() => videoRecorder()!.emit('segment-3'));
    await waitFor(() => expect(segmentCalls.map((c) => c.idx)).toEqual([2, 3]));
    expect(await store.segments('int1')).toEqual([]);
  });

  it('does not record when the candidate declined recording, but still shows the self-view', async () => {
    await openRoom({ mode: 'VIDEO', voiceEnabled: true, recording: false });
    expect(await screen.findByRole('complementary', { name: 'Your camera' })).toBeInTheDocument();
    await waitFor(() => expect(fake.media.streams.length).toBeGreaterThan(0));
    expect(videoRecorder()).toBeUndefined();
    expect(screen.queryByText('Recording')).not.toBeInTheDocument();
  });

  it('switches from typing back to video', async () => {
    const { api } = await openRoom(
      { mode: 'TEXT', voiceEnabled: true, recording: true },
      { handlers: { 'POST /interviews/int1/mode': () => ok({ mode: 'VIDEO' }) } },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Answer on camera' }));
    expect(api.calls.find((c) => c.key === 'POST /interviews/int1/mode')!.body).toEqual({
      mode: 'VIDEO',
      reason: 'CANDIDATE_CHOICE',
    });
    expect(await screen.findByRole('complementary', { name: 'Your camera' })).toBeInTheDocument();
  });
});

describe('session observations', () => {
  let visibility: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  const setVisibility = (state: DocumentVisibilityState) =>
    act(() => {
      visibility = state;
      document.dispatchEvent(new Event('visibilitychange'));
    });

  it('notes tab switches and pastes (length only) when tracking is on', async () => {
    const { sockets } = await openRoom({ integrityTracking: true });
    expect(await screen.findByText('Session observations are on.')).toBeInTheDocument();
    await waitFor(() => expect(sockets.last.sent('interview:join')).toHaveLength(1));

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    setVisibility('hidden');
    now.mockReturnValue(1_004_500);
    setVisibility('visible');
    // A repeated "visible" is not a second return.
    setVisibility('visible');
    now.mockRestore();

    const pasted = 'console.log("copied answer")';
    fireEvent.paste(screen.getByLabelText('Your answer'), {
      clipboardData: { getData: () => pasted },
    });

    const events = sockets.last.sent('integrity:event') as IntegrityEventPayload[];
    expect(events.map((e) => [e.type, e.value])).toEqual([
      ['TAB_HIDDEN', undefined],
      ['TAB_VISIBLE', 4_500],
      ['PASTE', pasted.length],
    ]);
    expect(events[2]).toEqual({
      sessionId: 'int1',
      type: 'PASTE',
      at: expect.any(String),
      value: pasted.length,
    });
    expect(JSON.stringify(events)).not.toContain('copied answer');
    // Never a warning: observations are not shown as problems.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('notes nothing when tracking is off', async () => {
    const { sockets } = await openRoom({ integrityTracking: false });
    await waitFor(() => expect(sockets.last.sent('interview:join')).toHaveLength(1));
    expect(screen.queryByText('Session observations are on.')).not.toBeInTheDocument();

    setVisibility('hidden');
    setVisibility('visible');
    fireEvent.paste(screen.getByLabelText('Your answer'), {
      clipboardData: { getData: () => 'pasted' },
    });
    expect(sockets.last.sent('integrity:event')).toEqual([]);
  });
});
