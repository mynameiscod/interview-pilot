import type { AdminMediaAsset, PlaybackUrl } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { formatBytes, formatDuration, playbackSrc, segmentsLabel } from './format';
import { privacyKeys, useMediaAsset } from './queries';
import { DeletionState, IntegrityTimeline, MediaStatusBadge } from './shared';

function Summary({ asset }: { asset: AdminMediaAsset }) {
  const { t, i18n } = useTranslation();
  const date = (value: string | null) => (value ? formatDateTime(value, i18n.language) : '—');
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby="recording-summary-heading"
    >
      <h2 id="recording-summary-heading" className="h6">
        {t('privacy.detail.summary')}
      </h2>
      <dl className="row small mb-0">
        <dt className="col-sm-4 col-lg-3">{t('privacy.recordings.candidate')}</dt>
        <dd className="col-sm-8 col-lg-9">
          {asset.userEmail ?? '—'}
          <div className="font-monospace cb-text-secondary">{asset.userId}</div>
        </dd>
        <dt className="col-sm-4 col-lg-3">{t('privacy.recordings.interview')}</dt>
        <dd className="col-sm-8 col-lg-9">
          {asset.interviewTitle ?? '—'}
          <div className="font-monospace cb-text-secondary">{asset.sessionId}</div>
        </dd>
        <dt className="col-sm-4 col-lg-3">{t('privacy.recordings.segments')}</dt>
        <dd className="col-sm-8 col-lg-9">{segmentsLabel(t, asset)}</dd>
        <dt className="col-sm-4 col-lg-3">{t('privacy.detail.duration')}</dt>
        <dd className="col-sm-8 col-lg-9">
          {asset.durationMs === null ? '—' : formatDuration(t, asset.durationMs)}
        </dd>
        <dt className="col-sm-4 col-lg-3">{t('privacy.recordings.size')}</dt>
        <dd className="col-sm-8 col-lg-9">{formatBytes(asset.bytes, i18n.language)}</dd>
        <dt className="col-sm-4 col-lg-3">{t('privacy.detail.format')}</dt>
        <dd className="col-sm-8 col-lg-9 font-monospace">{asset.mimeType}</dd>
        <dt className="col-sm-4 col-lg-3">{t('privacy.file.label')}</dt>
        <dd className="col-sm-8 col-lg-9">
          {t(`privacy.file.status.${asset.playbackFile}`)}
          {asset.parts > 1 && (
            <div className="cb-text-secondary">
              {t('privacy.file.parts', { count: asset.parts })}
            </div>
          )}
        </dd>
        <dt className="col-sm-4 col-lg-3">{t('library.created')}</dt>
        <dd className="col-sm-8 col-lg-9">{date(asset.createdAt)}</dd>
        <dt className="col-sm-4 col-lg-3">{t('privacy.recordings.retention')}</dt>
        <dd className="col-sm-8 col-lg-9">{date(asset.retentionExpiresAt)}</dd>
        <dt className="col-sm-4 col-lg-3">{t('privacy.recordings.deletion')}</dt>
        <dd className="col-sm-8 col-lg-9 mb-0">
          <DeletionState deletion={asset.deletion} />
          {asset.deletion.reason && (
            <div className="cb-text-secondary">
              {t('privacy.detail.deletionReason', { reason: asset.deletion.reason })}
            </div>
          )}
        </dd>
      </dl>
      {asset.status === 'PARTIAL' && asset.missingSegments.length > 0 && (
        <div className="mt-3">
          <h3 className="h6">{t('privacy.detail.missingTitle')}</h3>
          <p className="small cb-text-secondary mb-1">{t('privacy.detail.missingHint')}</p>
          <ul className="list-inline small mb-0" aria-label={t('privacy.detail.missingTitle')}>
            {asset.missingSegments.map((index) => (
              <li key={index} className="list-inline-item badge text-bg-light border">
                {t('privacy.detail.segmentIndex', { index })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Until the recording is joined into one file it plays part by part (each
 * camera restart made a part), moving on at the end of one, like the
 * candidate's player.
 */
function Player({ asset }: { asset: AdminMediaAsset }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const [playback, setPlayback] = useState<PlaybackUrl | null>(null);
  const [partIndex, setPartIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Each open issues a fresh, short-lived link (and one audit entry).
  const watch = useMutation({
    mutationFn: () => manager.api.post<PlaybackUrl>(`/admin/media/${asset.id}/playback`),
    onSuccess: (result) => {
      setError(null);
      setPartIndex(0);
      setPlayback(result);
    },
    onError: (err) => setError(consoleError(t, err)),
  });
  const playable = asset.deletion.status === 'NONE' && asset.segmentCount > 0;
  const parts = playback ? (playback.parts.length > 0 ? playback.parts : [playback.url]) : [];
  const src = parts[partIndex] ?? parts[0];

  function showPart(index: number, autoplay: boolean) {
    setPartIndex(index);
    if (autoplay) {
      // The element keeps its identity; play once the new source is set.
      queueMicrotask(() => void videoRef.current?.play()?.catch(() => undefined));
    }
  }

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('privacy.player.title')}
      </h2>
      {!playable && (
        <p className="small cb-text-secondary mb-0">
          {asset.deletion.status === 'DELETED'
            ? t('privacy.player.deleted')
            : t('privacy.player.nothingStored')}
        </p>
      )}
      {playable && (
        <>
          <p id={`${id}-logged`} className="small cb-text-secondary">
            <i className="bi bi-eye me-1" aria-hidden="true" />
            {t('privacy.player.logged')}
          </p>
          {playback === null ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={watch.isPending}
              aria-describedby={`${id}-logged`}
              onClick={() => watch.mutate()}
            >
              <i className="bi bi-play-fill me-1" aria-hidden="true" />
              {t('privacy.player.watch')}
            </button>
          ) : (
            <>
              <video
                ref={videoRef}
                controls
                preload="metadata"
                className="w-100 rounded-2 bg-dark mb-2"
                style={{ maxHeight: '28rem' }}
                src={playbackSrc(src!)}
                aria-label={t('privacy.player.videoLabel')}
                onEnded={() => {
                  if (partIndex < parts.length - 1) showPart(partIndex + 1, true);
                }}
              />
              {parts.length > 1 && (
                <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
                  <p className="small cb-text-secondary mb-0 me-auto" aria-live="polite">
                    {t('privacy.player.part', { current: partIndex + 1, total: parts.length })}
                    <span className="d-block">{t('privacy.player.partsNote')}</span>
                  </p>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    disabled={partIndex === 0}
                    onClick={() => showPart(partIndex - 1, false)}
                  >
                    <i className="bi bi-skip-backward-fill me-1" aria-hidden="true" />
                    {t('privacy.player.previousPart')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    disabled={partIndex >= parts.length - 1}
                    onClick={() => showPart(partIndex + 1, false)}
                  >
                    {t('privacy.player.nextPart')}
                    <i className="bi bi-skip-forward-fill ms-1" aria-hidden="true" />
                  </button>
                </div>
              )}
              <div className="d-flex flex-wrap gap-2 align-items-center">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => setPlayback(null)}
                >
                  {t('privacy.player.close')}
                </button>
                <span className="small cb-text-secondary">
                  {t('privacy.player.expires', {
                    at: formatDateTime(playback.expiresAt, i18n.language),
                  })}
                </span>
              </div>
            </>
          )}
          <div className="mt-2">
            <ErrorAlert error={error} />
          </div>
        </>
      )}
    </section>
  );
}

/** File states that can be built again (not while a build is queued or running). */
const REBUILDABLE = new Set<AdminMediaAsset['playbackFile']>(['READY', 'FAILED', 'UNAVAILABLE']);

/** Queues the joined, seekable file to be built again (audited). */
function RebuildFile({ asset, onQueued }: { asset: AdminMediaAsset; onQueued: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const rebuild = useMutation({
    mutationFn: () => manager.api.post<AdminMediaAsset>(`/admin/media/${asset.id}/rebuild-file`),
    onSuccess: async (next) => {
      setError(null);
      queryClient.setQueryData(privacyKeys.mediaAsset(asset.id), next);
      await queryClient.invalidateQueries({ queryKey: privacyKeys.media });
      onQueued();
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  if (asset.deletion.status === 'DELETED' || !REBUILDABLE.has(asset.playbackFile)) return null;
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('privacy.file.heading')}
      </h2>
      <p id={`${id}-hint`} className="small cb-text-secondary">
        {t(asset.playbackFile === 'READY' ? 'privacy.file.hintReady' : 'privacy.file.hintMissing')}
      </p>
      <button
        type="button"
        className="btn btn-sm btn-outline-primary"
        disabled={rebuild.isPending}
        aria-describedby={`${id}-hint`}
        onClick={() => rebuild.mutate()}
      >
        <i className="bi bi-arrow-repeat me-1" aria-hidden="true" />
        {t('privacy.file.rebuild')}
      </button>
      <div className="mt-2">
        <ErrorAlert error={error} />
      </div>
    </section>
  );
}

function Purge({ asset, onPurged }: { asset: AdminMediaAsset; onPurged: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const purge = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<AdminMediaAsset>(`/admin/media/${asset.id}/purge`, { reason }),
    onSuccess: async (next) => {
      setOpen(false);
      setConfirmed(false);
      setError(null);
      queryClient.setQueryData(privacyKeys.mediaAsset(asset.id), next);
      await queryClient.invalidateQueries({ queryKey: privacyKeys.media });
      onPurged();
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  if (asset.deletion.status === 'DELETED') return null;
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('privacy.purge.heading')}
      </h2>
      {!open ? (
        <button
          type="button"
          className="btn btn-sm btn-outline-danger"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          {t('privacy.purge.button')}
        </button>
      ) : (
        <ReasonForm
          submitLabel={t('privacy.purge.confirm')}
          danger
          pending={purge.isPending}
          disabled={!confirmed}
          error={error}
          onSubmit={(reason) => purge.mutate(reason)}
          onCancel={() => {
            setOpen(false);
            setConfirmed(false);
            setError(null);
          }}
        >
          <p className="fw-semibold mb-1">{t('privacy.purge.title')}</p>
          <ul className="small">
            <li>{t('privacy.purge.explainNow')}</li>
            <li>{t('privacy.purge.explainKept')}</li>
          </ul>
          <div className="form-check mb-2">
            <input
              id={`${id}-confirm`}
              type="checkbox"
              className="form-check-input"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <label htmlFor={`${id}-confirm`} className="form-check-label">
              {t('privacy.purge.acknowledge')}
            </label>
          </div>
        </ReasonForm>
      )}
    </section>
  );
}

export function RecordingDetailPage() {
  const { t } = useTranslation();
  const { mediaId = '' } = useParams();
  const canManage = useCan('media.manage');
  const asset = useMediaAsset(mediaId);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <p className="mb-2">
        <Link to="/recordings" className="small">
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          {t('privacy.detail.back')}
        </Link>
      </p>
      <h1 className="h3 mb-1">{t('privacy.detail.title')}</h1>
      <p className="cb-text-secondary font-monospace small">
        {mediaId}
        {asset.data && (
          <span className="ms-2">
            <MediaStatusBadge status={asset.data.status} />
          </span>
        )}
      </p>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {asset.isPending && <LoadingRow />}
      {asset.isError && <ErrorAlert error={consoleError(t, asset.error)} />}
      {asset.data && (
        <>
          <Summary asset={asset.data} />
          {/* Remounts after a purge so a stale player never outlives its recording. */}
          <Player key={asset.data.deletion.status} asset={asset.data} />
          <IntegrityTimeline sessionId={asset.data.sessionId} />
          {canManage && (
            <RebuildFile asset={asset.data} onQueued={() => setNotice(t('privacy.file.queued'))} />
          )}
          {canManage && (
            <Purge asset={asset.data} onPurged={() => setNotice(t('privacy.purge.done'))} />
          )}
        </>
      )}
    </>
  );
}
