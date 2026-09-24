import { CostGroupBy } from '@cbi/shared-types';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { consoleError, featureName, providerName } from '../ai/format';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { DataFreshness } from './AnalyticsDashboard';
import { LineChart } from './charts';
import { formatDay, formatPaise, formatRate } from './format';
import { useCosts } from './queries';
import { RangePicker } from './RangePicker';
import { useRangeParam } from './useRangeParam';

export function CostsPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [range, setRange] = useRangeParam();
  const [params, setParams] = useSearchParams();
  const parsedGroup = CostGroupBy.safeParse(params.get('groupBy'));
  const groupBy = parsedGroup.success ? parsedGroup.data : 'feature';
  const costs = useCosts(range, groupBy);
  const data = costs.data;
  const number = new Intl.NumberFormat(i18n.language);

  const setGroupBy = (next: CostGroupBy) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.set('groupBy', next);
        return updated;
      },
      { replace: true },
    );

  const keyLabel = (key: string) => {
    if (groupBy === 'provider') return providerName(t, key);
    if (groupBy === 'day') return formatDay(key, i18n.language);
    return key;
  };

  return (
    <>
      <h1 className="h3 mb-2">{t('analytics.costs.title')}</h1>
      <p className="cb-text-secondary">{t('analytics.costs.subtitle')}</p>
      <RangePicker range={range} onChange={setRange} />
      <div className="mb-3" style={{ maxWidth: '16rem' }}>
        <label htmlFor={`${id}-group`} className="form-label small mb-1">
          {t('analytics.costs.groupBy')}
        </label>
        <select
          id={`${id}-group`}
          className="form-select form-select-sm"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as CostGroupBy)}
        >
          {CostGroupBy.options.map((g) => (
            <option key={g} value={g}>
              {t(`analytics.costs.groups.${g}`)}
            </option>
          ))}
        </select>
      </div>

      {costs.isPending && <LoadingRow />}
      <ErrorAlert error={costs.isError ? consoleError(t, costs.error) : null} />
      {data && (
        <div aria-busy={costs.isFetching}>
          <DataFreshness usdToInr={data.usdToInr} />
          <section aria-labelledby={`${id}-totals`} className="mb-4">
            <h2 id={`${id}-totals`} className="h5">
              {t('analytics.costs.totals')}
            </h2>
            <div className="row g-3">
              {[
                ['aiCost', formatPaise(data.totals.aiCostMinor)],
                [
                  'aiCostPerInterview',
                  data.totals.aiCostPerInterviewMinor === null
                    ? '—'
                    : formatPaise(data.totals.aiCostPerInterviewMinor),
                  t('analytics.costs.completedInterviews', {
                    count: data.totals.completedInterviews,
                  }),
                ],
                ['calls', number.format(data.totals.calls)],
                ['revenue', formatPaise(data.totals.revenueMinor)],
                ['refunds', formatPaise(data.totals.refundsMinor)],
                ['gatewayFees', formatPaise(data.totals.gatewayFeesMinor)],
                ['margin', formatPaise(data.totals.marginMinor)],
                ['grossMargin', formatRate(data.totals.grossMargin, i18n.language)],
              ].map(([key, value, note]) => (
                <div className="col-6 col-md-4 col-xl-3" key={key}>
                  <div
                    className="p-3 border cb-border rounded-3 bg-white h-100"
                    role="group"
                    aria-label={t(`analytics.costs.cards.${key}`)}
                  >
                    <div className="small cb-text-secondary">
                      {t(`analytics.costs.cards.${key}`)}
                    </div>
                    <div className="fs-5 fw-semibold">{value}</div>
                    {note && <div className="small cb-text-secondary">{note}</div>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section
            className="border cb-border rounded-3 bg-white mb-4"
            aria-label={t('analytics.costs.breakdown')}
          >
            <div className="table-responsive">
              <table className="table align-middle mb-0">
                <thead>
                  <tr>
                    <th scope="col">{t(`analytics.costs.groups.${groupBy}`)}</th>
                    <th scope="col" className="text-end">
                      {t('analytics.costs.calls')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('analytics.costs.failures')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('analytics.costs.cost')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('analytics.costs.share')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="cb-text-secondary">
                        {t('analytics.costs.empty')}
                      </td>
                    </tr>
                  )}
                  {data.rows.map((r) => (
                    <tr key={r.key}>
                      <th scope="row" className="fw-normal">
                        {groupBy === 'feature' ? (
                          <>
                            <code>{r.key}</code>
                            {featureName(t, r.key) && (
                              <span className="d-block small cb-text-secondary">
                                {featureName(t, r.key)}
                              </span>
                            )}
                          </>
                        ) : (
                          keyLabel(r.key)
                        )}
                      </th>
                      <td className="text-end">{number.format(r.calls)}</td>
                      <td className="text-end">{number.format(r.failures)}</td>
                      <td className="text-end">{formatPaise(r.costMinor)}</td>
                      <td className="text-end">
                        {formatRate(
                          data.totals.aiCostMinor > 0
                            ? r.costMinor / data.totals.aiCostMinor
                            : null,
                          i18n.language,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <LineChart
            title={t('analytics.costs.marginChart')}
            days={data.margin.map((m) => m.day)}
            format={formatPaise}
            formatDay={(d) => formatDay(d, i18n.language)}
            series={[
              {
                key: 'revenue',
                label: t('analytics.costs.cards.revenue'),
                tone: 'primary',
                values: data.margin.map((m) => m.revenueMinor),
              },
              {
                key: 'aiCost',
                label: t('analytics.costs.cards.aiCost'),
                tone: 'danger',
                pattern: 'dashed',
                values: data.margin.map((m) => m.aiCostMinor),
              },
              {
                key: 'margin',
                label: t('analytics.costs.cards.margin'),
                tone: 'success',
                pattern: 'dotted',
                values: data.margin.map((m) => m.marginMinor),
              },
            ]}
          />
        </div>
      )}
    </>
  );
}
