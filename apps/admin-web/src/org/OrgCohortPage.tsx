import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleError } from '../features/ai/format';
import { ErrorAlert, LoadingRow } from '../features/ai/shared';
import { downloadExport } from '../features/campaigns/format';
import { queryString, useCohort, useOrgCampaigns, type CohortFilters } from './queries';
import { useOrgAuth, useOrgCan } from './session';

const EMPTY: CohortFilters = { campaignId: '', batch: '', branch: '', year: '' };

const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

/** A horizontal bar (share of the largest value); the number is always shown as text too. */
function Bar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="progress" style={{ height: '0.5rem' }} aria-hidden="true">
      <div className="progress-bar" style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * College (TPO) readiness across the college's campaigns: participation,
 * readiness bands and dimension averages on each student's latest attempt,
 * and improvement between each student's first and latest attempts.
 */
export function OrgCohortPage() {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useOrgAuth();
  const canExport = useOrgCan('org.export');
  const [filters, setFilters] = useState<CohortFilters>(EMPTY);
  const cohort = useCohort(filters);
  const campaigns = useOrgCampaigns(1);
  const [error, setError] = useState<string | null>(null);
  const data = cohort.data;
  const set = (key: keyof CohortFilters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));

  async function download() {
    setError(null);
    try {
      await downloadExport(
        manager,
        `/org/analytics/cohort.csv${queryString(filters)}`,
        'cohort-readiness.csv',
      );
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  const maxBand = Math.max(0, ...(data?.bands ?? []).map((b) => b.count));

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
        <h1 className="h3 mb-0">{t('orgPortal.cohort.title')}</h1>
        {canExport && (
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            onClick={() => void download()}
          >
            <i className="bi bi-filetype-csv me-1" aria-hidden="true" />
            {t('orgPortal.cohort.csv')}
          </button>
        )}
      </div>
      <p className="cb-text-secondary">{t('orgPortal.cohort.intro')}</p>
      <form className="row g-2 mb-3" onSubmit={(e) => e.preventDefault()}>
        <div className="col-sm-6 col-lg-4">
          <label htmlFor={`${id}-campaign`} className="form-label small">
            {t('orgPortal.cohort.campaign')}
          </label>
          <select
            id={`${id}-campaign`}
            className="form-select form-select-sm"
            value={filters.campaignId}
            onChange={(e) => set('campaignId', e.target.value)}
          >
            <option value="">{t('orgPortal.cohort.allCampaigns')}</option>
            {(campaigns.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {(['batch', 'branch', 'year'] as const).map((key) => (
          <div className="col-sm-4 col-lg-2" key={key}>
            <label htmlFor={`${id}-${key}`} className="form-label small">
              {t(`orgPortal.invites.${key}`)}
            </label>
            <select
              id={`${id}-${key}`}
              className="form-select form-select-sm"
              value={filters[key]}
              onChange={(e) => set(key, e.target.value)}
            >
              <option value="">{t('orgPortal.pipeline.any')}</option>
              {(data?.tagValues[key] ?? []).map((v) => (
                <option key={String(v)} value={String(v)}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        ))}
      </form>
      <ErrorAlert error={error} />
      {cohort.isPending ? (
        <LoadingRow />
      ) : cohort.isError ? (
        <ErrorAlert error={consoleError(t, cohort.error)} />
      ) : (
        <>
          <div className="row g-3 mb-3">
            {(
              [
                ['invited', data!.participation.invited],
                ['joined', data!.participation.joined],
                ['completed', data!.participation.completed],
                ['rate', percent(data!.participation.rate)],
                ['averageDelta', data!.improvement.averageDelta ?? '—'],
              ] as const
            ).map(([key, value]) => (
              <div className="col-6 col-md" key={key}>
                <div className="p-3 border cb-border rounded-3 bg-white h-100">
                  <div className="small cb-text-secondary">{t(`orgPortal.cohort.kpi.${key}`)}</div>
                  <div className="fs-4 fw-semibold">{value}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="row g-3 mb-3">
            <section className="col-lg-6" aria-labelledby={`${id}-bands`}>
              <div className="p-3 border cb-border rounded-3 bg-white h-100">
                <h2 id={`${id}-bands`} className="h6">
                  {t('orgPortal.cohort.bands')}
                </h2>
                {data!.bands.length === 0 ? (
                  <p className="small mb-0">{t('orgPortal.cohort.noScores')}</p>
                ) : (
                  <ul className="list-unstyled mb-0">
                    {data!.bands.map((b) => (
                      <li key={b.band} className="mb-2">
                        <div className="d-flex justify-content-between small">
                          <span>{t(`orgPortal.bands.${b.band}`, { defaultValue: b.band })}</span>
                          <span>{b.count}</span>
                        </div>
                        <Bar value={b.count} max={maxBand} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
            <section className="col-lg-6" aria-labelledby={`${id}-dims`}>
              <div className="p-3 border cb-border rounded-3 bg-white h-100">
                <h2 id={`${id}-dims`} className="h6">
                  {t('orgPortal.cohort.dimensions')}
                </h2>
                {data!.dimensions.length === 0 ? (
                  <p className="small mb-0">{t('orgPortal.cohort.noScores')}</p>
                ) : (
                  <ul className="list-unstyled mb-0">
                    {data!.dimensions.map((d) => (
                      <li key={d.key} className="mb-2">
                        <div className="d-flex justify-content-between small">
                          <span>{d.name}</span>
                          <span>{d.average ?? '—'}</span>
                        </div>
                        <Bar value={d.average ?? 0} max={100} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
          <section aria-labelledby={`${id}-students`}>
            <h2 id={`${id}-students`} className="h6">
              {t('orgPortal.cohort.students', {
                improved: data!.improvement.improved,
                declined: data!.improvement.declined,
              })}
            </h2>
            {data!.students.length === 0 ? (
              <p className="p-3 border cb-border rounded-3 bg-white">
                {t('orgPortal.cohort.empty')}
              </p>
            ) : (
              <div className="table-responsive border cb-border rounded-3 bg-white">
                <table className="table table-sm align-middle mb-0">
                  <caption className="visually-hidden">
                    {t('orgPortal.cohort.studentsCaption')}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('orgPortal.pipeline.candidate')}</th>
                      <th scope="col">{t('orgPortal.invites.tags')}</th>
                      <th scope="col">{t('orgPortal.cohort.attempts')}</th>
                      <th scope="col">{t('orgPortal.cohort.first')}</th>
                      <th scope="col">{t('orgPortal.cohort.latest')}</th>
                      <th scope="col">{t('orgPortal.cohort.improvement')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.students.map((s) => (
                      <tr key={s.userId}>
                        <td>
                          {s.name ?? s.email}
                          <div className="small cb-text-secondary">{s.email}</div>
                        </td>
                        <td className="small">
                          {[s.tags?.batch, s.tags?.branch, s.tags?.year]
                            .filter(Boolean)
                            .join(' · ')}
                        </td>
                        <td>{s.attempts}</td>
                        <td>{s.firstOverall ?? '—'}</td>
                        <td>{s.latestOverall ?? '—'}</td>
                        <td>
                          {s.improvement === null
                            ? '—'
                            : s.improvement > 0
                              ? `+${s.improvement}`
                              : s.improvement}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
