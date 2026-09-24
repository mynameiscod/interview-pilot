import { MEDIA_LIMITS } from '@cbi/shared-types';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useCandidateAuth } from '../../app/session';
import {
  containerType,
  micProblem,
  openCamera,
  pickVideoMimeType,
  stopStream,
  type MicProblem,
} from '../voice/media';
import { asSendResult, sendSegment, useMediaApi } from './media-api';
import { defaultSegmentStore } from './segment-store';
import { getUploadQueue, type UploadStatus } from './upload-queue';

export type TrackKind = 'video' | 'audio';

/**
 * The camera and microphone for a video interview (self-view and
 * recording), open while `enabled`. `onTrackEnded` hears when the browser
 * stops a track by itself (camera unplugged, permission revoked).
 */
export function useCameraStream(enabled: boolean, onTrackEnded?: (kind: TrackKind) => void) {
  const [state, setState] = useState<{ stream: MediaStream | null; problem: MicProblem | null }>({
    stream: null,
    problem: null,
  });
  const endedRef = useRef(onTrackEnded);
  useEffect(() => {
    endedRef.current = onTrackEnded;
  }, [onTrackEnded]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let opened: MediaStream | null = null;
    const cleanups: (() => void)[] = [];
    openCamera()
      .then((stream) => {
        if (cancelled) {
          stopStream(stream);
          return;
        }
        opened = stream;
        for (const track of stream.getTracks()) {
          const onEnded = () => endedRef.current?.(track.kind === 'video' ? 'video' : 'audio');
          track.addEventListener?.('ended', onEnded);
          cleanups.push(() => track.removeEventListener?.('ended', onEnded));
        }
        setState({ stream, problem: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ stream: null, problem: micProblem(err) });
      });
    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
      stopStream(opened);
      setState({ stream: null, problem: null });
    };
  }, [enabled]);

  return state;
}

/**
 * Records a video interview for its whole length: one MediaRecorder on the
 * camera stream emits a segment every `MEDIA_LIMITS.timesliceMs`, and each
 * goes into the interview's upload queue (persisted, retried, in order).
 *
 * - `active`: record now (video mode with recording on). Turning it off, or
 *   unmounting, stops the recorder; its last chunk is still queued.
 * - `ended`: the interview is over or left video mode: once the recorder has
 *   stopped and every segment is uploaded, the recording is finalized.
 *
 * The queue outlives the room, so uploads carry on in the background while
 * the page is open. It also resumes segments left over from a reload.
 */
export function useInterviewRecording({
  sessionId,
  stream,
  active,
  ended,
}: {
  sessionId: string;
  stream: MediaStream | null;
  active: boolean;
  ended: boolean;
}): UploadStatus & { recording: boolean } {
  const { manager } = useCandidateAuth();
  const api = useMediaApi();
  const makeDeps = useCallback(
    () => ({
      store: defaultSegmentStore(),
      send: (idx: number, blob: Blob, contentType: string) =>
        sendSegment(manager, sessionId, idx, blob, contentType),
      finalize: (body: Parameters<typeof api.finalize>[1]) =>
        asSendResult(() => api.finalize(sessionId, body)),
    }),
    [manager, api, sessionId],
  );
  const queue = useMemo(() => getUploadQueue(sessionId, makeDeps), [sessionId, makeDeps]);
  const status = useSyncExternalStore(queue.subscribe, queue.getStatus, queue.getStatus);
  const [recording, setRecording] = useState(false);

  // Back online: retry straight away rather than waiting out the backoff.
  useEffect(() => {
    const online = () => queue.retryNow();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [queue]);

  const shouldRecord = active && stream !== null && !status.closed;
  useEffect(() => {
    if (!shouldRecord || !stream) return;
    let stopped = false;
    let recorder: MediaRecorder | null = null;
    void queue.ready().then(() => {
      if (stopped || !queue.accepting) return;
      const mimeType = pickVideoMimeType();
      if (!mimeType) return;
      try {
        recorder = new MediaRecorder(stream, { mimeType });
      } catch {
        return;
      }
      const type = containerType(recorder.mimeType || mimeType);
      let lastChunkAt = performance.now();
      recorder.ondataavailable = (e: BlobEvent) => {
        const now = performance.now();
        if (!e.data || e.data.size === 0) return;
        queue.add(e.data, type, now - lastChunkAt);
        lastChunkAt = now;
      };
      recorder.start(MEDIA_LIMITS.timesliceMs);
      setRecording(true);
    });
    return () => {
      stopped = true;
      const active = recorder;
      setRecording(false);
      if (!active || active.state === 'inactive') return;
      // The last chunk arrives before `stop`; finishing waits for it.
      queue.trackStop(
        new Promise<void>((resolve) => {
          active.onstop = () => resolve();
        }),
      );
      active.stop();
    };
  }, [queue, stream, shouldRecord]);

  useEffect(() => {
    if (ended) void queue.finish();
  }, [queue, ended]);

  return { ...status, recording };
}
