import { VOICE_LIMITS } from '@cbi/shared-types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMedia, type FakeMedia } from '../../test/fake-media';
import { useRecorder, type Recording } from './voice-hooks';

const MAX_MS = VOICE_LIMITS.maxAnswerSec * 1000;

let fake: FakeMedia;
let clock = 0;

beforeEach(() => {
  vi.useFakeTimers();
  fake = installFakeMedia();
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  fake.uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useRecorder at the answer limit', () => {
  it('calls onLimit once and finishes once, however long the recorder takes to stop', async () => {
    const results: (Recording | null)[] = [];
    let stop: () => Promise<Recording | null> = async () => null;
    const onLimit = vi.fn(() => {
      void stop().then((r) => results.push(r));
    });
    const { result } = renderHook(() => useRecorder(onLimit));
    stop = () => result.current.stop();

    await act(() => result.current.start());
    expect(result.current.recording).toBe(true);
    const recorder = fake.media.recorders[0]!;
    // A slow browser: `onstop` arrives a whole second (five ticks) after stop().
    recorder.stop = function (this: typeof recorder) {
      this.state = 'inactive';
      setTimeout(() => {
        this.ondataavailable?.({ data: new Blob(['answer'], { type: this.mimeType }) });
        this.onstop?.();
      }, 1_000);
    };

    clock += MAX_MS + 10;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onLimit).toHaveBeenCalledTimes(1);

    // The ticks that follow, while the recorder is still stopping, must not fire it again.
    clock += 1_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ durationMs: MAX_MS });
    expect(results[0]!.blob.size).toBeGreaterThan(0);
    expect(result.current.recording).toBe(false);
  });

  it('stops ticking as soon as the candidate stops, before onstop arrives', async () => {
    const onLimit = vi.fn();
    const { result } = renderHook(() => useRecorder(onLimit));
    await act(() => result.current.start());
    const recorder = fake.media.recorders[0]!;
    recorder.stop = function (this: typeof recorder) {
      this.state = 'inactive';
      setTimeout(() => this.onstop?.(), 5_000);
    };
    clock += MAX_MS - 100;
    let finished: Recording | null = null;
    act(() => {
      void result.current.stop().then((r) => (finished = r));
    });
    // The limit passes while the recorder is still stopping.
    clock += 1_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onLimit).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(finished).toMatchObject({ durationMs: MAX_MS - 100 });
    expect(onLimit).not.toHaveBeenCalled();
  });
});
