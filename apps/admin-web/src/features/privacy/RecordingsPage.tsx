import { MediaDeletionStatus, MediaStatus } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { formatBytes, segmentsLabel } from './format';
import { useMediaAssets } from './queries';
import { DeletionState, MediaStatusBadge } from './shared';

const isStatus = (value: string | null): value is MediaStatus =>
  MediaStatus.safeParse(value).success;
const isDeletion = (value: string | null): value is MediaDeletionStatus =>
  MediaDeletionStatus.safeParse(value).success;

export function RecordingsPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  // Filters live in the URL so returning from a recording keeps them.
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const rawDeletion = params.get('deletion');
  const status = isStatus(rawStatus) ? rawStatus : '';
  const deletion = isDeletion(rawDeletion) ? rawDeletion : '';
  const q = params.get('q')?.trim() ?? '';
  const [statusInput, setStatusInput] = useState<string>(status);
  const [deletionInput, setDeletionInput] = useState<string>(deletion);
  const [qInput, setQInput] = useState(q);
  const assets = useMediaAssets({ status, deletion, q });

  return (
    <>
      <h1 className="h3 mb-2">{t('privacy.recordings.title')}</h1>
      <p className="cb-text-secondary">{t('privacy.recordings.subtitle')}</p>
      <form
        role="search"
        aria-label={t('privacy.recordings.filtersLabel')}
        className="row g-2 align-items-end mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams();
          if (statusInput) next.set('status', statusInput);
          if (deletionInput) next.set('deletion', deletionInput);
          if (qInput.trim()) next.set('q', qInput.trim());
          setParams(next);
        }}
      >
        <div className="col-sm-6 col-lg-2">
          <label htmlFor={`${id}-status`} className="form-label small">
            {t('privacy.recordings.statusFilter')}
          </label>
          <select
            id={`${id}-status`}
            className="form-select form-select-sm"
            value={statusInput}
            onChange={(e) => setStatusInput(e.target.value)}
          >
            <option value="">{t('privacy.recordings.allStatuses')}</option>
            {MediaStatus.options.map((s) => (
              <option key={s} value={s}>
                {t(`privacy.mediaStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-sm-6 col-lg-2">
          <label htmlFor={`${id}-deletion`} className="form-label small">
            {t('privacy.recordings.deletionFilter')}
          </label>
          <select
            id={`${id}-deletion`}
            className="form-select form-select-sm"
            value={deletionInput}
            onChange={(e) => setDeletionInput(e.target.value)}
          >
            <option value="">{t('privacy.recordings.allDeletion')}</option>
            {MediaDeletionStatus.options.map((s) => (
              <option key={s} value={s}>
                {t(`privacy.deletionFilter.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-sm-8 col-lg-5">
          <label htmlFor={`${id}-q`} className="form-label small">
            {t('privacy.recordings.search')}
          </label>
          <input
            id={`${id}-q`}
            type="search"
            className="form-control form-control-sm"
            maxLength={120}
            value={qInput}
            aria-describedby={`${id}-q-hint`}
            onChange={(e) => setQInput(e.target.value)}
          />
          <div id={`${id}-q-hint`} className="form-text">
            {t('privacy.recordings.searchHint')}
          </div>
        </div>
        <div className="col-sm-4 col-lg-3 pb-lg-4">
          <button type="submit" className="btn btn-sm btn-primary">
            {t('privacy.recordings.apply')}
          </button>
        </div>
      </form>
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('privacy.recordings.listLabel')}
      >
        {assets.isPending && <LoadingRow />}
        {assets.isError && (
          <div className="m-3">
            <ErrorAlert error={consoleError(t, assets.error)} />
          </div>
        )}
        {assets.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('library.created')}</th>
                  <th scope="col">{t('privacy.recordings.candidate')}</th>
                  <th scope="col">{t('privacy.recordings.interview')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col">{t('privacy.recordings.segments')}</th>
                  <th scope="col" className="text-end">
                    {t('privacy.recordings.size')}
                  </th>
                  <th scope="col">{t('privacy.recordings.retention')}</th>
                  <th scope="col">{t('privacy.recordings.deletion')}</th>
                </tr>
              </thead>
              <tbody>
                {assets.data.length === 0 && (
                  <tr>
                    <td colSpan={8} className="cb-text-secondary">
                      {t('privacy.recordings.empty')}
                    </td>
                  </tr>
                )}
                {assets.data.map((a) => (
                  <tr key={a.id}>
                    <td className="small text-nowrap">
                      {formatDateTime(a.createdAt, i18n.language)}
                    </td>
                    <th scope="row" className="fw-normal small">
                      <Link
                        to={`/recordings/${a.id}`}
                        aria-label={t('privacy.recordings.openLabel', {
                          who: a.userEmail ?? a.userId,
                        })}
                      >
                        {a.userEmail ?? <span className="font-monospace">{a.userId}</span>}
                      </Link>
                    </th>
                    <td>{a.interviewTitle ?? '—'}</td>
                    <td>
                      <MediaStatusBadge status={a.status} />
                    </td>
                    <td className="small text-nowrap">{segmentsLabel(t, a)}</td>
                    <td className="small text-end text-nowrap">
                      {formatBytes(a.bytes, i18n.language)}
                    </td>
                    <td className="small text-nowrap">
                      {formatDateTime(a.retentionExpiresAt, i18n.language)}
                    </td>
                    <td>
                      <DeletionState deletion={a.deletion} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
