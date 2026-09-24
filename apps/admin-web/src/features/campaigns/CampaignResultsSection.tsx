import { ApplicationStatus, type CampaignSummary } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { campaignError, downloadExport } from './format';
import { resultsQuery, useCampaignResults, type ResultsFilters } from './queries';
import { ApplicationStatusBadge } from './shared';

const isStatus = (value: string | null): value is ApplicationStatus =>
  ApplicationStatus.safeParse(value).success;

const score = (value: string | null) =>
  value !== null && /^\d{1,3}$/.test(value) && Number(value) <= 100 ? value : '';

/** Filters live in the URL so returning from an interview keeps them. */
function useResultsFilters(): [ResultsFilters, (next: ResultsFilters) => void] {
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const rawDimension = params.get('dimension') ?? '';
  const filters: ResultsFilters = {
    status: isStatus(rawStatus) ? rawStatus : '',
    minOverall: score(params.get('minOverall')),
    dimension: /^[a-z0-9-]+:\d{1,3}$/.test(rawDimension) ? rawDimension : '',
  };
  const set = (next: ResultsFilters) => {
    const search = new URLSearchParams();
    if (next.status) search.set('status', next.status);
    if (next.minOverall) search.set('minOverall', next.minOverall);
    if (next.dimension) search.set('dimension', next.dimension);
    setParams(search, { replace: true });
  };
  return [filters, set];
}

function Exports({ campaign, filters }: { campaign: CampaignSummary; filters: ResultsFilters }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const [busy, setBusy] = useState<'csv' | 'zip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (kind: 'csv' | 'zip') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'csv') {
        await downloadExport(
          manager,
          `/admin/campaigns/${campaign.id}/results.csv${resultsQuery(filters)}`,
          `campaign-${campaign.id}-results.csv`,
        );
      } else {
        await downloadExport(
          manager,
          `/admin/campaigns/${campaign.id}/package.zip`,
          `campaign-${campaign.id}.zip`,
        );
      }
    } catch (err) {
      setError(campaignError(t, err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-3">
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={busy !== null}
          aria-describedby={`${id}-hint`}
          onClick={() => void download('csv')}
        >
          <i className="bi bi-filetype-csv me-1" aria-hidden="true" />
          {busy === 'csv' ? t('campaigns.exports.downloading') : t('campaigns.exports.csv')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={busy !== null}
          aria-describedby={`${id}-hint`}
          onClick={() => void download('zip')}
        >
          <i className="bi bi-file-earmark-zip me-1" aria-hidden="true" />
          {busy === 'zip' ? t('campaigns.exports.downloading') : t('campaigns.exports.package')}
        </button>
      </div>
      <p id={`${id}-hint`} className="small cb-text-secondary mt-2 mb-0">
        {t('campaigns.exports.hint')}
      </p>
      <div className="mt-2">
        <ErrorAlert error={error} />
      </div>
    </div>
  );
}

export function CampaignResultsSection({ campaign }: { campaign: CampaignSummary }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const canExport = useCan('campaigns.manage');
  const canReview = useCan('interviews.read');
  const [filters, setFilters] = useResultsFilters();
  const results = useCampaignResults(campaign.id, filters);
  const [dimKey, dimMin] = filters.dimension ? filters.dimension.split(':') : ['', ''];
  const [statusInput, setStatusInput] = useState(filters.status);
  const [minInput, setMinInput] = useState(filters.minOverall);
  const [dimensionInput, setDimensionInput] = useState(dimKey ?? '');
  const [dimensionMinInput, setDimensionMinInput] = useState(dimMin ?? '');
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
        <div className="col-lg-2">
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
              {t('campaigns.results.caption', { count: results.data.rows.length })}
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
    </section>
  );
}
