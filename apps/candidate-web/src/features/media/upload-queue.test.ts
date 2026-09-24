import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemorySegmentStore, type SegmentStore } from './segment-store';
import {
  classifyUpload,
  retryDelay,
  SegmentUploadQueue,
  type SendResult,
  type UploadQueueDeps,
} from './upload-queue';

const SESSION = 'int1';

type Reply = SendResult | Error;

/** A sender that answers from a script (then 201s), recording every index sent. */
function scriptedSender(script: Reply[] = []) {
  const sent: number[] = [];
  const send = vi.fn(async (idx: number, _blob: Blob, _contentType: string) => {
    sent.push(idx);
    const next = script.shift() ?? { status: 201 };
    if (next instanceof Error) throw next;
    return next;
  });
  return { send, sent };
}

let queues: SegmentUploadQueue[] = [];

function makeQueue(deps: Partial<UploadQueueDeps> & { store?: SegmentStore } = {}) {
  const queue = new SegmentUploadQueue(SESSION, {
    store: deps.store ?? createMemorySegmentStore(),
    send: deps.send ?? scriptedSender().send,
    finalize: deps.finalize ?? vi.fn(async () => ({ status: 200 })),
    random: () => 0.5, // no jitter: 1 s, 2 s, 4 s …
    log: deps.log ?? vi.fn(),
  });
  queues.push(queue);
  return queue;
}

const chunk = (text: string) => new Blob([text], { type: 'video/webm' });

/** Lets queued promise work (store reads, sends) run. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  queues.forEach((q) => q.dispose());
  queues = [];
  vi.useRealTimers();
});

describe('recording upload queue', () => {
  it('uploads segments one at a time, in index order', async () => {
    const { send, sent } = scriptedSender();
    const queue = makeQueue({ send });
    await queue.ready();

    expect(queue.add(chunk('a'), 'video/webm', 10_000)).toBe(0);
    expect(queue.add(chunk('b'), 'video/webm', 10_000)).toBe(1);
    expect(queue.add(chunk('c'), 'video/webm', 10_000)).toBe(2);
    expect(queue.getStatus().waiting).toBeGreaterThan(0);
    await settle();

    expect(sent).toEqual([0, 1, 2]);
    expect(send.mock.calls[0]![2]).toBe('video/webm');
    expect(queue.getStatus()).toMatchObject({ waiting: 0, retrying: false });
  });

  it('retries after a 503 with exponential backoff, and treats a duplicate as stored', async () => {
    const { send, sent: calls } = scriptedSender([
      { status: 503, code: 'PROVIDER_UNAVAILABLE' },
      new TypeError('Failed to fetch'),
      { status: 200 }, // The earlier attempt had reached the server: a duplicate.
    ]);
    const queue = makeQueue({ send });
    await queue.ready();
    queue.add(chunk('a'), 'video/webm', 10_000);
    queue.add(chunk('b'), 'video/webm', 10_000);
    await settle();

    expect(calls).toEqual([0]);
    expect(queue.getStatus()).toMatchObject({ waiting: 2, retrying: true });

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    // The network error doubles the wait.
    expect(calls).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    // 200 (duplicate) counts as stored; the next segment follows without waiting.
    expect(calls).toEqual([0, 0, 0, 1]);
    expect(queue.getStatus()).toMatchObject({ waiting: 0, retrying: false });
  });

  it('persists un-acknowledged segments and resumes them after a reload', async () => {
    const store = createMemorySegmentStore();
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const first = makeQueue({ store, send: offline });
    await first.ready();
    first.add(chunk('a'), 'video/webm', 10_000);
    first.add(chunk('b'), 'video/webm', 9_000);
    await settle();
    expect((await store.segments(SESSION)).map((s) => s.idx)).toEqual([0, 1]);
    expect(await store.getMeta(SESSION)).toMatchObject({ nextIdx: 2, durationMs: 19_000 });
    first.dispose(); // The page was closed.

    const { send, sent } = scriptedSender();
    const second = makeQueue({ store, send });
    expect(await second.ready()).toMatchObject({ nextIdx: 2, ended: false });
    await settle();
    expect(sent).toEqual([0, 1]);
    expect(await store.segments(SESSION)).toEqual([]);

    // New segments continue the numbering.
    expect(second.add(chunk('c'), 'video/webm', 10_000)).toBe(2);
    await settle();
    expect(sent).toEqual([0, 1, 2]);
  });

  it('drops a segment the server cannot store (415, index conflict) and carries on', async () => {
    const log = vi.fn();
    const { send, sent } = scriptedSender([
      { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
      { status: 409, code: 'CONFLICT' },
    ]);
    const store = createMemorySegmentStore();
    const queue = makeQueue({ send, log, store });
    await queue.ready();
    queue.add(chunk('a'), 'video/webm', 10_000);
    queue.add(chunk('b'), 'video/webm', 10_000);
    queue.add(chunk('c'), 'video/webm', 10_000);
    await settle();

    expect(sent).toEqual([0, 1, 2]);
    expect(log).toHaveBeenCalledWith(
      'recording segment dropped',
      expect.objectContaining({ idx: 0, status: 415 }),
    );
    expect(log).toHaveBeenCalledWith(
      'recording segment dropped',
      expect.objectContaining({ idx: 1, code: 'CONFLICT' }),
    );
    expect(await store.segments(SESSION)).toEqual([]);
    expect(queue.getStatus().closed).toBe(false);
  });

  it('stops when the server no longer takes segments', async () => {
    const { send, sent } = scriptedSender([{ status: 409, code: 'INVALID_STATE' }]);
    const store = createMemorySegmentStore();
    const queue = makeQueue({ send, store });
    await queue.ready();
    queue.add(chunk('a'), 'video/webm', 10_000);
    queue.add(chunk('b'), 'video/webm', 10_000);
    await settle();

    expect(sent).toEqual([0]);
    expect(queue.getStatus()).toMatchObject({ closed: true, done: true, waiting: 0 });
    expect(queue.add(chunk('c'), 'video/webm', 10_000)).toBe(-1);
    expect(await store.getMeta(SESSION)).toBeNull();
  });

  it('finalizes with every segment produced once the queue is empty', async () => {
    const { send } = scriptedSender([{ status: 503 }]);
    const finalize = vi.fn(async () => ({ status: 200 }));
    const store = createMemorySegmentStore();
    const queue = makeQueue({ send, finalize, store });
    await queue.ready();
    queue.add(chunk('a'), 'video/webm', 10_000);
    queue.add(chunk('b'), 'video/webm', 10_000);
    let stopRecorder!: () => void;
    queue.trackStop(new Promise<void>((r) => (stopRecorder = r)));
    const finished = queue.finish();
    await settle();
    expect(finalize).not.toHaveBeenCalled();

    // The recorder's last chunk arrives as it stops.
    queue.add(chunk('c'), 'video/webm', 4_500);
    stopRecorder();
    await finished;
    await settle();
    // Segment 0 is still waiting for its retry: nothing is finalized yet.
    expect(finalize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith({ segmentCount: 3, durationMs: 24_500 });
    expect(queue.getStatus()).toMatchObject({ done: true, waiting: 0 });
    expect(await store.getMeta(SESSION)).toBeNull();
  });

  it('does not finalize an interview that never recorded here', async () => {
    const finalize = vi.fn(async () => ({ status: 200 }));
    const queue = makeQueue({ finalize });
    await queue.finish();
    await settle();
    expect(finalize).not.toHaveBeenCalled();
  });
});

describe('upload decisions', () => {
  it('classifies server answers', () => {
    expect(classifyUpload({ status: 201 })).toBe('done');
    expect(classifyUpload({ status: 200 })).toBe('done');
    expect(classifyUpload({ status: 503 })).toBe('retry');
    expect(classifyUpload({ status: 429 })).toBe('retry');
    expect(classifyUpload({ status: 415 })).toBe('drop');
    expect(classifyUpload({ status: 413 })).toBe('drop');
    expect(classifyUpload({ status: 409, code: 'CONFLICT' })).toBe('drop');
    expect(classifyUpload({ status: 409, code: 'INVALID_STATE' })).toBe('stop');
  });

  it('backs off 1 s, 2 s, 4 s … up to 60 s, with jitter', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 6, 10].map((a) => retryDelay(a, mid))).toEqual([
      1_000, 2_000, 4_000, 8_000, 60_000, 60_000,
    ]);
    expect(retryDelay(0, () => 0)).toBe(800);
    expect(retryDelay(0, () => 1)).toBe(1_200);
    expect(retryDelay(10, () => 1)).toBe(60_000);
  });
});
