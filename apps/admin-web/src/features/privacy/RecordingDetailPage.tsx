import type { AdminMediaAsset, PlaybackUrl } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
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

function Player({ asset }: { asset: AdminMediaAsset }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const [playback, setPlayback] = useState<PlaybackUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each open issues a fresh, short-lived link (and one audit entry).
  const watch = useMutation({
    mutationFn: () => manager.api.post<PlaybackUrl>(`/admin/media/${asset.id}/playback`),
    onSuccess: (result) => {
      setError(null);
      setPlayback(result);
    },
    onError: (err) => setError(consoleError(t, err)),
  });
  const playable = asset.deletion.status === 'NONE' && asset.segmentCount > 0;

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
                controls
                preload="metadata"
                className="w-100 rounded-2 bg-dark mb-2"
                style={{ maxHeight: '28rem' }}
                src={playbackSrc(playback.url)}
                aria-label={t('privacy.player.videoLabel')}
              />
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
            <Purge asset={asset.data} onPurged={() => setNotice(t('privacy.purge.done'))} />
          )}
        </>
      )}
    </>
  );
}
