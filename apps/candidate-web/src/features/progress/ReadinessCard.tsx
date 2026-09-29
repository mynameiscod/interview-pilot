import type { ProgressOverview } from '@cbi/shared-types';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../interviews/messages';

const TrendChart = lazy(() => import('./TrendChart'));

/** Readiness per completed interview over time: a line chart plus the same data as a table. */
export function ReadinessCard({ progress }: { progress: ProgressOverview }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.resolvedLanguage;
  const trend = progress.readiness.trend;
  const labels = trend.map((p) => formatDate(lng, p.at));
  const scored = trend.filter((p) => p.overall !== null);
  const summary =
    scored.length > 0
      ? t('progress.readiness.chartSummary', {
          count: scored.length,
          first: scored[0]!.overall,
          last: scored.at(-1)!.overall,
        })
      : t('progress.readiness.noScores');

  return (
    <section className="cb-dash-card h-100" aria-labelledby="readiness-title">
      <div className="d-flex flex-wrap align-items-baseline justify-content-between gap-2 mb-2">
        <h2 id="readiness-title" className="h5 mb-0 d-flex align-items-center gap-2">
          <i className="bi bi-graph-up-arrow text-secondary" aria-hidden="true" />
          {t('progress.readiness.title')}
        </h2>
        {progress.focusRole && (
          <span className="small cb-text-secondary">
            {t('progress.readiness.role', { title: progress.focusRole.title })}
          </span>
        )}
      </div>
      {trend.length < 2 && (
        <p className="small cb-text-secondary mb-2">{t('progress.readiness.onePoint')}</p>
      )}
      <Suspense
        fallback={
          <div className="cb-trend-chart d-flex align-items-center justify-content-center">
            <span className="small cb-text-secondary">{t('common.loading')}</span>
          </div>
        }
      >
        <TrendChart labels={labels} values={trend.map((p) => p.overall)} summary={summary} />
      </Suspense>
      <table className="visually-hidden">
        <caption>{t('progress.readiness.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('progress.readiness.colDate')}</th>
            <th scope="col">{t('progress.readiness.colInterview')}</th>
            <th scope="col">{t('progress.readiness.colScore')}</th>
            <th scope="col">{t('progress.readiness.colBand')}</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((p, i) => (
            <tr key={p.sessionId}>
              <td>{labels[i]}</td>
              <td>{p.title}</td>
              <td>{p.overall ?? t('progress.notScored')}</td>
              <td>{t(`report.band.${p.band}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
