import type { AiModelHealth } from '@cbi/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert, LoadingRow } from './shared';
import { consoleError } from './format';

const STATUS_BADGE: Record<AiModelHealth['status'], string> = {
  HEALTHY: 'text-bg-success',
  DEGRADED: 'text-bg-warning',
  DOWN: 'text-bg-danger',
  IDLE: 'text-bg-light border cb-border',
};
const STATUS_ICON: Record<AiModelHealth['status'], string> = {
  HEALTHY: 'bi-check-circle',
  DEGRADED: 'bi-exclamation-triangle',
  DOWN: 'bi-x-octagon',
  IDLE: 'bi-dash-circle',
};

export function HealthPage() {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const health = useQuery({
    queryKey: ['ai', 'health'],
    queryFn: () => manager.api.get<AiModelHealth[]>('/admin/ai/health'),
    refetchInterval: 30_000,
  });
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const ms = (v: number | null) => (v === null ? '—' : t('ai.health.ms', { value: v }));

  return (
    <>
      <p className="small cb-text-secondary">{t('ai.health.explain')}</p>
      <section className="border cb-border rounded-3 bg-white" aria-label={t('ai.tabs.health')}>
        {health.isPending && <LoadingRow />}
        {health.isError && (
          <div className="m-3">
            <ErrorAlert error={consoleError(t, health.error)} />
          </div>
        )}
        {health.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('ai.models.model')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col">{t('ai.health.breaker')}</th>
                  <th scope="col" className="text-end">
                    {t('ai.health.calls')}
                  </th>
                  <th scope="col" className="text-end">
                    {t('ai.health.errorRate')}
                  </th>
                  <th scope="col" className="text-end">
                    {t('ai.health.p50')}
                  </th>
                  <th scope="col" className="text-end">
                    {t('ai.health.p95')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.data.map((h) => (
                  <tr key={h.modelId}>
                    <th scope="row">
                      <code className="small">
                        {h.provider} / {h.model}
                      </code>
                    </th>
                    <td>
                      {/* Icon + text: status is never conveyed by colour alone. */}
                      <span className={`badge ${STATUS_BADGE[h.status]}`}>
                        <i className={`bi ${STATUS_ICON[h.status]} me-1`} aria-hidden="true" />
                        {t(`ai.health.status.${h.status}`)}
                      </span>
                    </td>
                    <td>{t(`ai.health.breakerState.${h.breaker}`)}</td>
                    <td className="text-end">{h.calls}</td>
                    <td className="text-end">{h.calls ? percent.format(h.errorRate) : '—'}</td>
                    <td className="text-end">{ms(h.p50LatencyMs)}</td>
                    <td className="text-end">{ms(h.p95LatencyMs)}</td>
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
