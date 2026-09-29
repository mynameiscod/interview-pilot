import {
  ApplicationStatus,
  CampaignResultsSort,
  type CampaignExport,
  type CampaignSummary,
} from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { formatBytes } from '../privacy/format';
import { campaignError, downloadExport } from './format';
import {
  RESULTS_PAGE_SIZE,
  resultsQuery,
  useCampaignExport,
  useCampaignResults,
  type ResultsFilters,
} from './queries';
import { ApplicationStatusBadge, Pager } from './shared';

const isStatus = (value: string | null): value is ApplicationStatus =>
  ApplicationStatus.safeParse(value).success;

const isSort = (value: string | null): value is CampaignResultsSort =>
  CampaignResultsSort.safeParse(value).success;

const score = (value: string | null) =>
  value !== null && /^\d{1,3}$/.test(value) && Number(value) <= 100 ? value : '';

/** Filters, order and page live in the URL so returning from an interview keeps them. */
function useResultsFilters(): [
  ResultsFilters,
  number,
  (next: ResultsFilters, page?: number) => void,
] {
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const rawSort = params.get('sort');
  const rawDimension = params.get('dimension') ?? '';
  const rawPage = Number(params.get('page'));
  const filters: ResultsFilters = {
    status: isStatus(rawStatus) ? rawStatus : '',
    minOverall: score(params.get('minOverall')),
    dimension: /^[a-z0-9-]+:\d{1,3}$/.test(rawDimension) ? rawDimension : '',
    sort: isSort(rawSort) && rawSort !== 'overall_desc' ? rawSort : '',
  };
  const page = Number.isInteger(rawPage) && rawPage > 1 ? rawPage : 1;
  // New filters start again from the first page.
  const set = (next: ResultsFilters, nextPage = 1) => {
    setParams(new URLSearchParams(resultsQuery(next, nextPage)), { replace: true });
  };
  return [filters, page, set];
}

/**
 * A package is built by the worker: start it, poll its progress, then
 * download it while it is kept.
 */
function PackageExport({ campaign }: { campaign: CampaignSummary }) {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const [exportId, setExportId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useCampaignExport(campaign.id, exportId);
  const current: CampaignExport | undefined = status.data;
  const building = current?.status === 'QUEUED' || current?.status === 'RUNNING';

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await manager.api.post<CampaignExport>(
        `/admin/campaigns/${campaign.id}/exports`,
      );
      setExportId(started.id);
    } catch (err) {
      setError(campaignError(t, err));
    } finally {
      setStarting(false);
    }
  };

  const download = async (path: string, fileName: string) => {
    setDownloading(true);
    setError(null);
    try {
      await downloadExport(manager, path, fileName);
    } catch (err) {
      setError(campaignError(t, err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mt-2">
      {(!current || !building) && current?.status !== 'READY' && (
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={starting}
          onClick={() => void start()}
        >
          <i className="bi bi-file-earmark-zip me-1" aria-hidden="true" />
          {starting
            ? t('campaignExport.package.starting')
            : current
              ? t('campaignExport.package.again')
              : t('campaignExport.package.start')}
        </button>
      )}
      <div role="status" aria-live="polite" className="small mt-2">
        {current?.status === 'QUEUED' && t('campaignExport.package.queued')}
        {current?.status === 'RUNNING' && (
          <>
            {t('campaignExport.package.running', {
              done: current.progress.done,
              total: current.progress.total,
            })}
            <div
              className="progress mt-1"
              role="progressbar"
              aria-label={t('campaignExport.package.progressLabel')}
              aria-valuemin={0}
              aria-valuemax={current.progress.total}
              aria-valuenow={current.progress.done}
            >
              <div
                className="progress-bar"
                style={{
                  width: `${current.progress.total ? (100 * current.progress.done) / current.progress.total : 0}%`,
                }}
              />
            </div>
          </>
        )}
        {current?.status === 'READY' &&
          t('campaignExport.package.ready', {
            size: formatBytes(current.sizeBytes ?? 0, i18n.language),
            expires: formatDateTime(current.expiresAt, i18n.language),
          })}
        {current?.status === 'FAILED' &&
          t('campaignExport.package.failed', { error: current.error ?? '' })}
        {current?.status === 'EXPIRED' && t('campaignExport.package.expired')}
      </div>
      {current?.status === 'READY' && current.downloadPath && (
        <button
          type="button"
          className="btn btn-sm btn-primary mt-2"
          disabled={downloading}
          onClick={() => void download(current.downloadPath!, current.fileName)}
        >
          <i className="bi bi-download me-1" aria-hidden="true" />
          {downloading ? t('campaigns.exports.downloading') : t('campaignExport.package.download')}
        </button>
      )}
      {status.isError && <ErrorAlert error={campaignError(t, status.error)} />}
      <ErrorAlert error={error} />
    </div>
  );
}

function Exports({ campaign, filters }: { campaign: CampaignSummary; filters: ResultsFilters }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const downloadCsv = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadExport(
        manager,
        `/admin/campaigns/${campaign.id}/results.csv${resultsQuery(filters)}`,
        `campaign-${campaign.id}-results.csv`,
      );
    } catch (err) {
      setError(campaignError(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3">
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={busy}
          aria-describedby={`${id}-hint`}
          onClick={() => void downloadCsv()}
        >
          <i className="bi bi-filetype-csv me-1" aria-hidden="true" />
          {busy ? t('campaigns.exports.downloading') : t('campaigns.exports.csv')}
        </button>
      </div>
      <p id={`${id}-hint`} className="small cb-text-secondary mt-2 mb-0">
        {t('campaigns.exports.hint')}
      </p>
      <div className="mt-2">
        <ErrorAlert error={error} />
      </div>
      <PackageExport campaign={campaign} />
    </div>
  );
}

export function CampaignResultsSection({ campaign }: { campaign: CampaignSummary }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const canExport = useCan('campaigns.manage');
  const canReview = useCan('interviews.read');
  const [filters, page, setFilters] = useResultsFilters();
  const results = useCampaignResults(campaign.id, filters, page);
  const [dimKey, dimMin] = filters.dimension ? filters.dimension.split(':') : ['', ''];
  const [statusInput, setStatusInput] = useState(filters.status);
  const [minInput, setMinInput] = useState(filters.minOverall);
  const [dimensionInput, setDimensionInput] = useState(dimKey ?? '');
  const [dimensionMinInput, setDimensionMinInput] = useState(dimMin ?? '');
  const [sortInput, setSortInput] = useState(filters.sort || 'overall_desc');
  const dimensions = results.data?.dimensions ?? [];
  const date = (value: string | null) => (value ? formatDateTime(value, i18n.language) : '—');

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('campaigns.results.title')}
      </h2>
      {canExport && <Exports campaign={campaign} filters={filters} />}
      <form
        role="search"
        aria-label={t('campaigns.results.filtersLabel')}
        className="row g-2 align-items-end mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          const min = score(dimensionMinInput.trim() || null);
          setFilters({
            status: statusInput,
            minOverall: score(minInput.trim() || null),
            dimension: dimensionInput && min ? `${dimensionInput}:${min}` : '',
            sort: sortInput === 'overall_desc' ? '' : sortInput,
          });
        }}
      >
        <div className="col-sm-6 col-lg-3">
          <label htmlFor={`${id}-status`} className="form-label small">
            {t('campaigns.results.statusFilter')}
          </label>
          <select
            id={`${id}-status`}
            className="form-select form-select-sm"
            value={statusInput}
            onChange={(e) => setStatusInput(e.target.value)}
          >
            <option value="">{t('campaigns.results.allStatuses')}</option>
            {ApplicationStatus.options.map((s) => (
              <option key={s} value={s}>
                {t(`campaigns.applicationStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-sm-6 col-lg-2">
          <label htmlFor={`${id}-min`} className="form-label small">
            {t('campaigns.results.minOverall')}
          </label>
          <input
            id={`${id}-min`}
            type="number"
            min={0}
            max={100}
            className="form-control form-control-sm"
            value={minInput}
            onChange={(e) => setMinInput(e.target.value)}
          />
        </div>
        <div className="col-sm-6 col-lg-3">
          <label htmlFor={`${id}-dimension`} className="form-label small">
            {t('campaigns.results.dimension')}
          </label>
          <select
            id={`${id}-dimension`}
            className="form-select form-select-sm"
            value={dimensionInput}
            onChange={(e) => setDimensionInput(e.target.value)}
          >
            <option value="">{t('campaigns.results.anyDimension')}</option>
            {dimensions.map((d) => (
              <option key={d.key} value={d.key}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="col-sm-6 col-lg-2">
          <label htmlFor={`${id}-dimension-min`} className="form-label small">
            {t('campaigns.results.dimensionMin')}
          </label>
          <input
            id={`${id}-dimension-min`}
            type="number"
            min={0}
            max={100}
            className="form-control form-control-sm"
            value={dimensionMinInput}
            disabled={!dimensionInput}
            onChange={(e) => setDimensionMinInput(e.target.value)}
          />
        </div>
        <div className="col-sm-6 col-lg-2">
          <label htmlFor={`${id}-sort`} className="form-label small">
            {t('campaignExport.sort.label')}
          </label>
          <select
            id={`${id}-sort`}
            className="form-select form-select-sm"
            value={sortInput}
            onChange={(e) => setSortInput(e.target.value)}
          >
            {CampaignResultsSort.options.map((o) => (
              <option key={o} value={o}>
                {t(`campaignExport.sort.${o}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-12">
          <button type="submit" className="btn btn-sm btn-primary">
            {t('payments.purchases.apply')}
          </button>
        </div>
      </form>
      {results.isPending && <LoadingRow />}
      {results.isError && <ErrorAlert error={campaignError(t, results.error)} />}
      {results.data && (
        <div className="table-responsive">
          <table className="table table-sm align-middle mb-0">
            <caption className="caption-top">
              {t('campaigns.results.caption', { count: results.data.total })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('campaigns.results.candidate')}</th>
                <th scope="col">{t('ai.status')}</th>
                <th scope="col">{t('campaigns.results.joined')}</th>
                <th scope="col">{t('campaigns.results.completed')}</th>
                <th scope="col" className="text-end">
                  {t('campaigns.results.overall')}
                </th>
                <th scope="col">{t('campaigns.results.band')}</th>
                <th scope="col">{t('campaigns.results.confidence')}</th>
                {results.data.dimensions.map((d) => (
                  <th scope="col" className="text-end" key={d.key}>
                    {d.name}
                  </th>
                ))}
                <th scope="col">{t('campaigns.results.review')}</th>
              </tr>
            </thead>
            <tbody>
              {results.data.rows.length === 0 && (
                <tr>
                  <td colSpan={8 + results.data.dimensions.length} className="cb-text-secondary">
                    {t('campaigns.results.empty')}
                  </td>
                </tr>
              )}
              {results.data.rows.map((row) => {
                const who = row.candidate.name ?? row.candidate.email ?? row.candidate.userId;
                return (
                  <tr key={row.applicationId}>
                    <th scope="row" className="fw-normal">
                      {row.candidate.name ?? '—'}
                      <div className="small cb-text-secondary">
                        {row.candidate.email ?? row.candidate.userId}
                      </div>
                    </th>
                    <td>
                      <ApplicationStatusBadge status={row.status} />
                    </td>
                    <td className="small text-nowrap">{date(row.joinedAt)}</td>
                    <td className="small text-nowrap">{date(row.completedAt)}</td>
                    <td className="text-end fw-semibold">{row.overall ?? '—'}</td>
                    <td className="small">
                      {row.band ? t(`review.bands.${row.band}`, { defaultValue: row.band }) : '—'}
                    </td>
                    <td className="small">
                      {row.confidence
                        ? t(`review.confidence.${row.confidence}`, {
                            defaultValue: row.confidence,
                          })
                        : '—'}
                    </td>
                    {results.data.dimensions.map((d) => (
                      <td className="text-end" key={d.key}>
                        {row.dimensions[d.key] ?? '—'}
                      </td>
                    ))}
                    <td className="text-nowrap">
                      {row.flagged && (
                        <span className="badge text-bg-danger me-2">
                          <i className="bi bi-flag-fill me-1" aria-hidden="true" />
                          {t('review.flagged')}
                        </span>
                      )}
                      {row.interviewId && canReview && (
                        <Link
                          to={`/interviews/${row.interviewId}`}
                          className="small"
                          aria-label={t('campaigns.results.openLabel', { who })}
                        >
                          {t('campaigns.results.open')}
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {results.data && (
        <Pager
          page={page}
          pageSize={RESULTS_PAGE_SIZE}
          total={results.data.total}
          onPage={(next) => setFilters(filters, next)}
          disabled={results.isPlaceholderData}
        />
      )}
    </section>
  );
}
