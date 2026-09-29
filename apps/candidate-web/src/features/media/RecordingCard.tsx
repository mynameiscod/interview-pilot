import type { MediaAssetSummary, PlaybackUrl } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate, inputErrorMessage } from '../interviews/messages';
import { mediaKeys, playbackSrc, useMediaApi, useRecording } from './media-api';

const STATUS_ICON: Record<MediaAssetSummary['status'], string> = {
  RECORDING: 'bi-hourglass-split text-secondary',
  COMPLETE: 'bi-check-circle-fill text-success',
  PARTIAL: 'bi-pie-chart text-secondary',
  FAILED: 'bi-x-circle text-secondary',
};

/** A new link is asked for at most this often when playback fails (an expired link). */
const REFRESH_AFTER_MS = 10_000;

/**
 * The interview's video recording, when there is one: its status, how long
 * it is kept, watching it (a short-lived link) and deleting it (confirmed
 * in the page). Nothing is shown for interviews that were not recorded.
 *
 * Until the recording is joined into one file it plays part by part (each
 * camera restart made a part), moving to the next part at the end of one.
 * When a link expires mid-watch the player asks for a new one and carries
 * on from the same moment.
 */
export function RecordingCard({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const recording = useRecording(sessionId);
  const api = useMediaApi();
  const queryClient = useQueryClient();
  const [playback, setPlayback] = useState<PlaybackUrl | null>(null);
  const [partIndex, setPartIndex] = useState(0);
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** Where to continue after a refreshed link loads. */
  const resumeAtRef = useRef<number | null>(null);
  const refreshedAtRef = useRef(0);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const asset = recording.data;
  if (!asset) return null;
  const deleted = asset.deletion.status === 'DELETED';
  const playable = !deleted && asset.status !== 'FAILED' && asset.segmentCount > 0;

  const parts = playback ? (playback.parts.length > 0 ? playback.parts : [playback.url]) : [];
  const src = parts[partIndex] ? playbackSrc(parts[partIndex]) : null;

  async function watch() {
    setOpening(true);
    setError(null);
    try {
      setPlayback(await api.playback(sessionId));
      setPartIndex(0);
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setOpening(false);
    }
  }

  /** The link expired (or the file changed): get new links and continue where it stopped. */
  async function refreshLink() {
    if (!playback || Date.now() - refreshedAtRef.current < REFRESH_AFTER_MS) {
      setError(t('recording.playbackFailed'));
      return;
    }
    refreshedAtRef.current = Date.now();
    const position = videoRef.current?.currentTime ?? 0;
    try {
      const next = await api.playback(sessionId);
      // Same layout (parts, or the file): keep the place. Otherwise start again.
      const same = next.source === playback.source && next.parts.length === playback.parts.length;
      resumeAtRef.current = same && position > 0 ? position : null;
      if (!same) setPartIndex(0);
      setPlayback(next);
    } catch (err) {
      setError(inputErrorMessage(t, err));
    }
  }

  function resume() {
    const at = resumeAtRef.current;
    resumeAtRef.current = null;
    if (at !== null && videoRef.current) videoRef.current.currentTime = at;
  }

  function showPart(index: number, autoplay: boolean) {
    resumeAtRef.current = null;
    setPartIndex(index);
    if (autoplay) {
      // The element keeps its identity; play once the new source is set.
      queueMicrotask(() => void videoRef.current?.play()?.catch(() => undefined));
    }
  }

  async function remove() {
    if (!asset) return;
    setDeleting(true);
    setError(null);
    try {
      await api.remove(sessionId);
      setPlayback(null);
      setConfirming(false);
      const removed: MediaAssetSummary = {
        ...asset,
        deletion: { status: 'DELETED', at: new Date().toISOString(), reason: null },
      };
      queryClient.setQueryData<MediaAssetSummary | null>(mediaKeys.recording(sessionId), removed);
      void queryClient.invalidateQueries({ queryKey: mediaKeys.recording(sessionId) });
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="recording-title">
      <h2 id="recording-title" className="h5">
        <i className="bi bi-camera-video me-2 text-secondary" aria-hidden="true" />
        {t('recording.title')}
      </h2>
      {deleted ? (
        <p className="mb-0" role="status">
          {t('recording.deleted')}
        </p>
      ) : (
        <>
          <p className="mb-1">
            <i className={`bi ${STATUS_ICON[asset.status]} me-2`} aria-hidden="true" />
            <span className="fw-semibold">{t(`recording.status.${asset.status}`)}</span>
          </p>
          <p className="small cb-text-secondary">
            {t('recording.retention', {
              date: formatDate(i18n.resolvedLanguage, asset.retentionExpiresAt),
            })}
          </p>
          {src && (
            <>
              <video
                ref={videoRef}
                className="d-block w-100 rounded-3 bg-dark mb-2"
                controls
                playsInline
                preload="metadata"
                src={src}
                aria-label={t('recording.player')}
                onLoadedMetadata={resume}
                onError={() => void refreshLink()}
                onEnded={() => {
                  if (partIndex < parts.length - 1) showPart(partIndex + 1, true);
                }}
              />
              {parts.length > 1 && (
                <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
                  <p className="small cb-text-secondary mb-0 me-auto" aria-live="polite">
                    {t('recording.part', { current: partIndex + 1, total: parts.length })}
                    <span className="d-block">{t('recording.partsNote')}</span>
                  </p>
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    disabled={partIndex === 0}
                    onClick={() => showPart(partIndex - 1, false)}
                  >
                    <i className="bi bi-skip-backward-fill me-1" aria-hidden="true" />
                    {t('recording.previousPart')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    disabled={partIndex >= parts.length - 1}
                    onClick={() => showPart(partIndex + 1, false)}
                  >
                    {t('recording.nextPart')}
                    <i className="bi bi-skip-forward-fill ms-1" aria-hidden="true" />
                  </button>
                </div>
              )}
            </>
          )}
          {error && (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          {confirming ? (
            <div
              role="group"
              className="p-3 border border-danger rounded-3"
              aria-labelledby="recording-delete-title"
            >
              <h3 id="recording-delete-title" ref={confirmRef} tabIndex={-1} className="h6">
                {t('recording.confirmTitle')}
              </h3>
              <p className="small mb-2">{t('recording.confirmBody')}</p>
              <div className="d-flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={deleting}
                  onClick={() => void remove()}
                >
                  {deleting ? t('recording.deleting') : t('recording.confirmDelete')}
                </button>
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm"
                  onClick={() => setConfirming(false)}
                >
                  {t('recording.keep')}
                </button>
              </div>
            </div>
          ) : (
            <div className="d-flex flex-wrap gap-2">
              {playable && !src && (
                <button
                  type="button"
                  className="btn btn-outline-primary"
                  disabled={opening}
                  onClick={() => void watch()}
                >
                  <i className="bi bi-play-fill me-1" aria-hidden="true" />
                  {opening ? t('recording.opening') : t('recording.watch')}
                </button>
              )}
              <button
                type="button"
                className="btn btn-outline-danger"
                onClick={() => setConfirming(true)}
              >
                <i className="bi bi-trash me-1" aria-hidden="true" />
                {t('recording.delete')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
