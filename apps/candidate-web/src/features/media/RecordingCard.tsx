import type { MediaAssetSummary } from '@cbi/shared-types';
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

/**
 * The interview's video recording, when there is one: its status, how long
 * it is kept, watching it (a short-lived link) and deleting it (confirmed
 * in the page). Nothing is shown for interviews that were not recorded.
 */
export function RecordingCard({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const recording = useRecording(sessionId);
  const api = useMediaApi();
  const queryClient = useQueryClient();
  const [src, setSrc] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const asset = recording.data;
  if (!asset) return null;
  const deleted = asset.deletion.status === 'DELETED';
  const playable = !deleted && asset.status !== 'FAILED' && asset.segmentCount > 0;

  async function watch() {
    setOpening(true);
    setError(null);
    try {
      const playback = await api.playback(sessionId);
      setSrc(playbackSrc(playback.url));
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setOpening(false);
    }
  }

  async function remove() {
    if (!asset) return;
    setDeleting(true);
    setError(null);
    try {
      await api.remove(sessionId);
      setSrc(null);
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
            <video
              className="d-block w-100 rounded-3 bg-dark mb-3"
              controls
              playsInline
              src={src}
              aria-label={t('recording.player')}
            />
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
