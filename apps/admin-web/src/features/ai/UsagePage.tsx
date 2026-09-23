import type {
  AiUsageEntriesPage,
  AiUsageGroupBy,
  AiUsageReport,
  AiUsageRow,
} from '@cbi/shared-types';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert, LoadingRow } from './shared';
import { consoleError, formatMicros } from './format';

const RANGES = { '24h': 1, '7d': 7, '30d': 30 } as const;
type Range = keyof typeof RANGES;

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const [range, setRange] = useState<Range>('7d');
  const [groupBy, setGroupBy] = useState<AiUsageGroupBy>('feature');
  const number = new Intl.NumberFormat(i18n.language);

  const report = useQuery({
    queryKey: ['ai-usage', range, groupBy],
    queryFn: () => {
      // Minute precision keeps the query key stable across re-renders.
      const to = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
      const from = new Date(to.getTime() - RANGES[range] * 24 * 3600 * 1000);
      const params = new URLSearchParams({
        groupBy,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      return manager.api.get<AiUsageReport>(`/admin/ai/usage?${params.toString()}`);
    },
  });
  const entries = useInfiniteQuery({
    queryKey: ['ai-usage-entries'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (pageParam) params.set('before', pageParam);
      return manager.api.get<AiUsageEntriesPage>(`/admin/ai/usage/entries?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const cost = (row: AiUsageRow) => {
    const parts = Object.entries(row.costMicros).map(([currency, micros]) =>
      formatMicros(micros, currency, i18n.language),
    );
    return parts.length ? parts.join(' + ') : formatMicros(0, 'USD', i18n.language);
  };
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'medium' });
  const rows = entries.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <h1 className="h3 mb-2">{t('ai.usage.title')}</h1>
      <p className="cb-text-secondary">{t('ai.usage.subtitle')}</p>
      <div className="d-flex flex-wrap gap-3 mb-3">
        <div>
          <label htmlFor={`${id}-range`} className="form-label small mb-1">
            {t('ai.usage.range')}
          </label>
          <select
            id={`${id}-range`}
            className="form-select form-select-sm"
            value={range}
            onChange={(e) => setRange(e.target.value as Range)}
          >
            {(Object.keys(RANGES) as Range[]).map((r) => (
              <option key={r} value={r}>
                {t(`ai.usage.ranges.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-group`} className="form-label small mb-1">
            {t('ai.usage.groupBy')}
          </label>
          <select
            id={`${id}-group`}
            className="form-select form-select-sm"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as AiUsageGroupBy)}
          >
            {(['feature', 'model', 'day'] as const).map((g) => (
              <option key={g} value={g}>
                {t(`ai.usage.groups.${g}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {report.isPending && <LoadingRow />}
      <ErrorAlert error={report.isError ? consoleError(t, report.error) : null} />
      {report.data && (
        <>
          <div className="row g-3 mb-3">
            {[
              ['ai.usage.totalCost', cost(report.data.totals)],
              ['ai.usage.totalCalls', number.format(report.data.totals.calls)],
              ['ai.usage.totalFailures', number.format(report.data.totals.failures)],
              [
                'ai.usage.totalTokens',
                t('ai.usage.tokens', {
                  input: number.format(report.data.totals.inputTokens),
                  output: number.format(report.data.totals.outputTokens),
                }),
              ],
            ].map(([key, value]) => (
              <div className="col-6 col-lg-3" key={key}>
                <div className="p-3 border cb-border rounded-3 bg-white h-100">
                  <div className="small cb-text-secondary">{t(key!)}</div>
                  <div className="fs-5 fw-semibold">{value}</div>
                </div>
              </div>
            ))}
          </div>
          <section
            className="border cb-border rounded-3 bg-white mb-4"
            aria-label={t('ai.usage.breakdown')}
          >
            <div className="table-responsive">
              <table className="table align-middle mb-0">
                <thead>
                  <tr>
                    <th scope="col">{t(`ai.usage.groups.${groupBy}`)}</th>
                    <th scope="col" className="text-end">
                      {t('ai.usage.calls')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('ai.usage.failures')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('ai.usage.inputTokens')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('ai.usage.outputTokens')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('ai.usage.avgLatency')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('ai.usage.cost')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="cb-text-secondary">
                        {t('ai.usage.empty')}
                      </td>
                    </tr>
                  )}
                  {report.data.rows.map((r) => (
                    <tr key={r.key}>
                      <th scope="row" className="fw-normal">
                        {groupBy === 'feature' ? <code>{r.key}</code> : r.key}
                      </th>
                      <td className="text-end">{number.format(r.calls)}</td>
                      <td className="text-end">{number.format(r.failures)}</td>
                      <td className="text-end">{number.format(r.inputTokens)}</td>
                      <td className="text-end">{number.format(r.outputTokens)}</td>
                      <td className="text-end">{t('ai.health.ms', { value: r.avgLatencyMs })}</td>
                      <td className="text-end">{cost(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <h2 className="h5">{t('ai.usage.recent')}</h2>
      <section className="border cb-border rounded-3 bg-white" aria-label={t('ai.usage.recent')}>
        {entries.isPending && <LoadingRow />}
        <ErrorAlert error={entries.isError ? consoleError(t, entries.error) : null} />
        {entries.data && (
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('ai.usage.time')}</th>
                  <th scope="col">{t('ai.usage.groups.feature')}</th>
                  <th scope="col">{t('ai.usage.groups.model')}</th>
                  <th scope="col">{t('ai.usage.outcome')}</th>
                  <th scope="col" className="text-end">
                    {t('ai.usage.latency')}
                  </th>
                  <th scope="col" className="text-end">
                    {t('ai.usage.cost')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="cb-text-secondary">
                      {t('ai.usage.empty')}
                    </td>
                  </tr>
                )}
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="small text-nowrap">{time.format(new Date(e.at))}</td>
                    <td>
                      <code className="small">{e.feature}</code>
                    </td>
                    <td className="small">
                      {e.provider} / {e.model}
                      {e.servedModel && e.servedModel !== e.model && (
                        <span className="d-block cb-text-secondary">
                          {t('ai.usage.servedBy', { model: e.servedModel })}
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${e.outcome === 'SUCCESS' ? 'text-bg-success' : 'text-bg-warning'}`}
                      >
                        {e.outcome}
                      </span>
                      {e.attempt > 1 && (
                        <span className="small cb-text-secondary ms-1">
                          {t('ai.usage.attempt', { n: e.attempt })}
                        </span>
                      )}
                    </td>
                    <td className="text-end small">{t('ai.health.ms', { value: e.latencyMs })}</td>
                    <td className="text-end small">
                      {formatMicros(e.costMicros, e.currency, i18n.language)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {entries.hasNextPage && (
          <div className="p-3 border-top cb-border">
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm"
              disabled={entries.isFetchingNextPage}
              onClick={() => void entries.fetchNextPage()}
            >
              {t('ai.usage.loadMore')}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
