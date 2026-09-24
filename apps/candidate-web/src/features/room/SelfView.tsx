import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { UploadStatus } from '../media/upload-queue';

/**
 * Video interviews: the candidate's own camera, small and mirrored in a
 * corner, with a "Recording" indicator while recording and a quiet note
 * while recorded parts are still being saved. Never blocks the room.
 */
export function SelfView({
  stream,
  unavailable,
  cameraLost,
  recording,
  uploads,
}: {
  stream: MediaStream | null;
  /** The camera could not be opened. */
  unavailable: boolean;
  /** The browser stopped the camera during the interview. */
  cameraLost: boolean;
  recording: boolean;
  uploads: UploadStatus | null;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    // A muted preview may autoplay; older browsers return undefined instead of a promise.
    if (stream) void Promise.resolve(video.play()).catch(() => undefined);
  }, [stream]);

  const waiting = uploads?.waiting ?? 0;
  const notice = unavailable
    ? t('video.selfView.unavailable')
    : cameraLost
      ? t('video.selfView.lost')
      : !stream
        ? t('video.selfView.starting')
        : null;

  return (
    <aside className="cb-self-view" aria-label={t('video.selfView.label')}>
      <div className="position-relative">
        <video
          ref={videoRef}
          className="d-block w-100 rounded-3 bg-dark shadow-sm cb-self-view-mirror"
          style={{ aspectRatio: '4 / 3' }}
          muted
          playsInline
          autoPlay
          hidden={!stream}
        />
        {notice && <div className="rounded-3 bg-dark text-white small p-2 shadow-sm">{notice}</div>}
        {recording && (
          <span className="position-absolute top-0 start-0 m-1 badge text-bg-dark d-inline-flex align-items-center gap-1">
            <span className="cb-voice-recording-dot" aria-hidden="true" />
            {t('video.recording')}
          </span>
        )}
      </div>
      <p
        className="small cb-text-secondary bg-white rounded-2 px-2 py-1 mt-1 mb-0 shadow-sm"
        role="status"
        hidden={waiting === 0}
      >
        {waiting > 0 && (
          <>
            <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
            {t('video.uploads.waiting', { count: waiting })}
          </>
        )}
      </p>
    </aside>
  );
}
