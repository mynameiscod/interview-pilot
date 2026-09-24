import type { Dashboard } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { consoleError, providerName } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { LineChart } from './charts';
import { daysInRange, formatDay, formatPaise, formatRate, type DayRange } from './format';
import { analyticsKeys, useDashboard } from './queries';
import { RangePicker } from './RangePicker';
import { useRangeParam } from './useRangeParam';

type TargetState = { met: boolean | null; text: string };

export function KpiTile({
  label,
  value,
  note,
  target,
}: {
  label: string;
  value: string;
  note?: string;
  target?: TargetState;
}) {
  const { t } = useTranslation();
  const badge =
    target?.met === true
      ? 'text-bg-success'
      : target?.met === false
        ? 'text-bg-danger'
        : 'text-bg-light border';
  const icon =
    target?.met === true
      ? 'bi-check-circle'
      : target?.met === false
        ? 'bi-exclamation-triangle'
        : 'bi-dash-circle';
  return (
    <div className="col-6 col-md-4 col-xl-3">
      <div
        className="p-3 border cb-border rounded-3 bg-white h-100"
        role="group"
        aria-label={label}
      >
        <div className="small cb-text-secondary">{label}</div>
        <div className="fs-5 fw-semibold">{value}</div>
        {note && <div className="small cb-text-secondary">{note}</div>}
        {target && (
          <div className="mt-1">
            <span className={`badge ${badge}`}>
              <i className={`bi ${icon} me-1`} aria-hidden="true" />
              {target.met === true
                ? t('analytics.targets.met')
                : target.met === false
                  ? t('analytics.targets.missed')
                  : t('analytics.targets.noData')}
            </span>
            <span className="small cb-text-secondary ms-1">{target.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpis({ data }: { data: Dashboard }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const rate = (value: number | null) => formatRate(value, i18n.language);
  const { kpis, targets } = data;
  /** Higher is better: met when the value reaches the target. */
  const atLeast = (value: number | null, target: number): TargetState => ({
    met: value === null ? null : value >= target,
    text: t('analytics.targets.atLeast', { value: rate(target) }),
  });
  const atMost = (value: number | null, limit: number): TargetState => ({
    met: value === null ? null : value <= limit,
    text: t('analytics.targets.atMost', { value: rate(limit) }),
  });

  const tiles: { key: string; value: string; note?: string; target?: TargetState }[] = [
    { key: 'registrations', value: number.format(kpis.registrations) },
    { key: 'activeUsers', value: number.format(kpis.activeUsers) },
    { key: 'interviewsStarted', value: number.format(kpis.interviewsStarted) },
    { key: 'interviewsCompleted', value: number.format(kpis.interviewsCompleted) },
    {
      key: 'completionRate',
      value: rate(kpis.completionRate),
      target: atLeast(kpis.completionRate, targets.completionRate),
    },
    {
      key: 'failureRate',
      value: rate(kpis.failureRate),
      note: t('analytics.kpis.failedCount', { count: kpis.interviewsFailed }),
      target: atMost(kpis.failureRate, targets.maxFailureRate),
    },
    {
      key: 'freeToPaidRate',
      value: rate(kpis.freeToPaidRate),
      target: atLeast(kpis.freeToPaidRate, targets.freeToPaidRate),
    },
    {
      key: 'grossMargin',
      value: rate(kpis.grossMargin),
      target: atLeast(kpis.grossMargin, targets.grossMargin),
    },
    { key: 'revenue', value: formatPaise(kpis.revenueMinor) },
    { key: 'refunds', value: formatPaise(kpis.refundsMinor) },
    { key: 'aiCost', value: formatPaise(kpis.aiCostMinor) },
    { key: 'gatewayFees', value: formatPaise(kpis.gatewayFeesMinor) },
    {
      key: 'activeSessions',
      value: number.format(kpis.activeSessions),
      note: t('analytics.kpis.rightNow'),
    },
  ];

  return (
    <section aria-labelledby="kpis-heading" className="mb-4">
      <h2 id="kpis-heading" className="h5">
        {t('analytics.kpis.title')}
      </h2>
      <div className="row g-3">
        {tiles.map((tile) => (
          <KpiTile
            key={tile.key}
            label={t(`analytics.kpis.${tile.key}`)}
            value={tile.value}
            note={tile.note}
            target={tile.target}
          />
        ))}
      </div>
    </section>
  );
}

function Funnel({ steps }: { steps: Dashboard['funnel'] }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const first = steps[0]?.users ?? 0;
  return (
    <section className="p-3 border cb-border rounded-3 bg-white mb-4" aria-labelledby="funnel-h">
      <h2 id="funnel-h" className="h5">
        {t('analytics.funnel.title')}
      </h2>
      <p className="small cb-text-secondary">{t('analytics.funnel.explain')}</p>
      {steps.length === 0 ? (
        <p className="small cb-text-secondary mb-0">{t('analytics.chart.empty')}</p>
      ) : (
        <ol className="list-unstyled mb-0">
          {steps.map((step, i) => {
            const prev = i > 0 ? steps[i - 1]!.users : null;
            const width = first > 0 ? Math.max((step.users / first) * 100, step.users ? 1 : 0) : 0;
            const label = t(`analytics.funnel.steps.${step.step}`, { defaultValue: step.step });
            return (
              <li key={step.step} className="mb-2">
                <div className="d-flex flex-wrap justify-content-between small">
                  <span className="fw-semibold">{label}</span>
                  <span>
                    {t('analytics.funnel.users', {
                      count: step.users,
                      value: number.format(step.users),
                    })}
                    {prev !== null && (
                      <span className="cb-text-secondary ms-2">
                        {prev > 0
                          ? t('analytics.funnel.conversion', {
                              value: formatRate(step.users / prev, i18n.language),
                            })
                          : t('analytics.funnel.noConversion')}
                      </span>
                    )}
                  </span>
                </div>
                <div className="progress" style={{ height: '0.75rem' }} aria-hidden="true">
                  <div className="progress-bar" style={{ width: `${width}%` }} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const HEALTH_BADGE: Record<string, string> = {
  HEALTHY: 'text-bg-success',
  DEGRADED: 'text-bg-warning',
  DOWN: 'text-bg-danger',
};

function ProviderHealth({ rows }: { rows: Dashboard['providerHealth'] }) {
  const { t, i18n } = useTranslation();
  return (
    <section className="mb-4" aria-labelledby="provider-health-h">
      <h2 id="provider-health-h" className="h5">
        {t('analytics.providerHealth.title')}
      </h2>
      {rows.length === 0 ? (
        <p className="small cb-text-secondary">{t('analytics.providerHealth.empty')}</p>
      ) : (
        <ul className="list-unstyled row g-2">
          {rows.map((row) => (
            <li className="col-sm-6 col-lg-4 col-xl-3" key={`${row.provider}/${row.model}`}>
              <div className="p-2 border cb-border rounded-3 bg-white h-100 small">
                <div className="fw-semibold text-truncate">
                  {providerName(t, row.provider)} / {row.model}
                </div>
                <span className={`badge ${HEALTH_BADGE[row.status] ?? 'text-bg-light border'}`}>
                  {t(`ai.health.status.${row.status}`, { defaultValue: row.status })}
                </span>
                <div className="cb-text-secondary mt-1">
                  {t('analytics.providerHealth.errorRate', {
                    value: formatRate(row.errorRate, i18n.language),
                  })}
                  {' · '}
                  {row.p95LatencyMs === null
                    ? t('analytics.providerHealth.noLatency')
                    : t('analytics.providerHealth.p95', { value: Math.round(row.p95LatencyMs) })}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Recompute({ range }: { range: DayRange }) {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recompute = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<{ days: number }>('/admin/analytics/rollup', { ...range, reason }),
    onSuccess: async (result) => {
      setOpen(false);
      setError(null);
      setNotice(t('analytics.recompute.done', { count: result.days }));
      await queryClient.invalidateQueries({ queryKey: analyticsKeys.all });
    },
    onError: (err) => setError(consoleError(t, err)),
  });
  return (
    <div className="mb-3">
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {open ? (
        <ReasonForm
          submitLabel={t('analytics.recompute.confirm')}
          pending={recompute.isPending}
          error={error}
          onSubmit={(reason) => recompute.mutate(reason)}
          onCancel={() => {
            setOpen(false);
            setError(null);
          }}
        >
          <p className="fw-semibold mb-1">
            {t('analytics.recompute.explain', {
              count: daysInRange(range.from, range.to),
              from: range.from,
              to: range.to,
            })}
          </p>
        </ReasonForm>
      ) : (
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          onClick={() => {
            setNotice(null);
            setOpen(true);
          }}
        >
          <i className="bi bi-arrow-repeat me-1" aria-hidden="true" />
          {t('analytics.recompute.button')}
        </button>
      )}
    </div>
  );
}

export function DataFreshness({
  computedAt,
  usdToInr,
  children,
}: {
  computedAt?: string | null;
  usdToInr: number;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  return (
    <p className="small cb-text-secondary">
      {computedAt !== undefined &&
        (computedAt
          ? t('analytics.dataAsOf', { time: formatDateTime(computedAt, i18n.language) })
          : t('analytics.notComputed'))}{' '}
      {t('analytics.usdToInr', {
        rate: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 4 }).format(usdToInr),
      })}
      {children}
    </p>
  );
}

/** The analytics dashboard (the console's landing page for analytics.read). */
export function AnalyticsDashboard() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const canRecompute = useCan('queues.manage');
  const [range, setRange] = useRangeParam();
  const dashboard = useDashboard(range);
  const data = dashboard.data;
  const day = (d: string) => formatDay(d, i18n.language);
  const number = new Intl.NumberFormat(i18n.language);

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="visually-hidden">
        {t('analytics.title')}
      </h2>
      <RangePicker range={range} onChange={setRange} />
      {canRecompute && <Recompute range={range} />}
      {dashboard.isPending && <LoadingRow />}
      <ErrorAlert error={dashboard.isError ? consoleError(t, dashboard.error) : null} />
      {data && (
        <div aria-busy={dashboard.isFetching}>
          <DataFreshness computedAt={data.computedAt} usdToInr={data.usdToInr} />
          <Kpis data={data} />
          <div className="row g-3 mb-4">
            <div className="col-lg-6">
              <LineChart
                title={t('analytics.charts.interviews')}
                days={data.series.map((s) => s.day)}
                format={(v) => number.format(v)}
                formatDay={day}
                series={[
                  {
                    key: 'started',
                    label: t('analytics.kpis.interviewsStarted'),
                    tone: 'primary',
                    values: data.series.map((s) => s.interviewsStarted),
                  },
                  {
                    key: 'completed',
                    label: t('analytics.kpis.interviewsCompleted'),
                    tone: 'success',
                    pattern: 'dashed',
                    values: data.series.map((s) => s.interviewsCompleted),
                  },
                ]}
              />
            </div>
            <div className="col-lg-6">
              <LineChart
                title={t('analytics.charts.revenueVsCost')}
                days={data.series.map((s) => s.day)}
                format={formatPaise}
                formatDay={day}
                series={[
                  {
                    key: 'revenue',
                    label: t('analytics.kpis.revenue'),
                    tone: 'primary',
                    values: data.series.map((s) => s.revenueMinor),
                  },
                  {
                    key: 'aiCost',
                    label: t('analytics.kpis.aiCost'),
                    tone: 'danger',
                    pattern: 'dashed',
                    values: data.series.map((s) => s.aiCostMinor),
                  },
                ]}
              />
            </div>
          </div>
          <Funnel steps={data.funnel} />
          <ProviderHealth rows={data.providerHealth} />
        </div>
      )}
    </section>
  );
}
