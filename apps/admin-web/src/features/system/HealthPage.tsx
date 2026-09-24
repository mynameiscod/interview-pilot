import type { SystemHealth } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCan } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatAge } from './format';
import { QueueCountsTable } from './shared';
import { HEALTH_REFRESH_MS, STALE_WORKER_SEC, useSystemHealth } from './queries';

const ENV_BADGE: Record<string, string> = {
  production: 'text-bg-danger',
  prod: 'text-bg-danger',
  staging: 'text-bg-warning',
};

function OkBadge({ ok }: { ok: boolean }) {
  const { t } = useTranslation();
  return ok ? (
    <span className="badge text-bg-success">
      <i className="bi bi-check-circle me-1" aria-hidden="true" />
      {t('system.health.ok')}
    </span>
  ) : (
    <span className="badge text-bg-danger">
      <i className="bi bi-x-octagon me-1" aria-hidden="true" />
      {t('system.health.failing')}
    </span>
  );
}

function Sessions({ sessions }: { sessions: SystemHealth['sessions'] }) {
  const { t, i18n } = useTranslation();
  const canSeeInterviews = useCan('interviews.read');
  const number = new Intl.NumberFormat(i18n.language);
  const processingLink = canSeeInterviews && (
    <Link to="/interviews?state=PROCESSING">{t('system.health.viewProcessing')}</Link>
  );
  return (
    <section className="p-3 border cb-border rounded-3 bg-white h-100" aria-labelledby="sessions-h">
      <h2 id="sessions-h" className="h6">
        {t('system.health.sessions')}
      </h2>
      <dl className="row small mb-2">
        <dt className="col-7">{t('system.health.live')}</dt>
        <dd className="col-5 text-end">{number.format(sessions.live)}</dd>
        <dt className="col-7">{t('system.health.processing')}</dt>
        <dd className="col-5 text-end">{number.format(sessions.processing)}</dd>
        <dt className="col-7">{t('system.health.stuck')}</dt>
        <dd className="col-5 text-end mb-0">{number.format(sessions.stuck)}</dd>
      </dl>
      {sessions.stuck > 0 ? (
        <div className="alert alert-warning py-2 small mb-0" role="alert">
          <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
          {t('system.health.stuckWarning', { count: sessions.stuck })} {processingLink}
        </div>
      ) : (
        processingLink && <div className="small">{processingLink}</div>
      )}
    </section>
  );
}

function Workers({ workers }: { workers: SystemHealth['workers'] }) {
  const { t, i18n } = useTranslation();
  const time = new Intl.DateTimeFormat(i18n.language, { timeStyle: 'medium' });
  const stale = workers.filter((w) => w.ageSec > STALE_WORKER_SEC).length;
  return (
    <section className="border cb-border rounded-3 bg-white mb-3" aria-labelledby="workers-h">
      <div className="p-3 pb-0">
        <h2 id="workers-h" className="h6">
          {t('system.health.workers')}
        </h2>
        {workers.length === 0 && (
          <div className="alert alert-danger py-2 small" role="alert">
            {t('system.health.noWorkers')}
          </div>
        )}
        {stale > 0 && (
          <div className="alert alert-warning py-2 small" role="alert">
            {t('system.health.staleWarning', { count: stale, seconds: STALE_WORKER_SEC })}
          </div>
        )}
      </div>
      {workers.length > 0 && (
        <div className="table-responsive">
          <table className="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th scope="col">{t('system.health.worker')}</th>
                <th scope="col">{t('system.health.version')}</th>
                <th scope="col">{t('system.health.queues')}</th>
                <th scope="col">{t('system.health.heartbeat')}</th>
                <th scope="col">{t('system.health.status')}</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => {
                const isStale = w.ageSec > STALE_WORKER_SEC;
                return (
                  <tr key={w.workerId} className={isStale ? 'table-warning' : undefined}>
                    <th scope="row" className="fw-normal">
                      <code className="small">{w.workerId}</code>
                    </th>
                    <td className="small">{w.version ?? '—'}</td>
                    <td className="small">{w.queues.join(', ') || '—'}</td>
                    <td className="small text-nowrap">
                      {formatAge(t, w.ageSec)}
                      <span className="d-block cb-text-secondary">
                        {time.format(new Date(w.at))}
                      </span>
                    </td>
                    <td>
                      {isStale ? (
                        <span className="badge text-bg-warning">
                          <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
                          {t('system.health.stale')}
                        </span>
                      ) : (
                        <span className="badge text-bg-success">
                          <i className="bi bi-check-circle me-1" aria-hidden="true" />
                          {t('system.health.alive')}
                        </span>
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

export function HealthPage() {
  const { t, i18n } = useTranslation();
  const health = useSystemHealth();
  const data = health.data;
  const time = new Intl.DateTimeFormat(i18n.language, { timeStyle: 'medium' });

  return (
    <>
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-2">
        <h1 className="h3 mb-0">{t('system.health.title')}</h1>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          disabled={health.isFetching}
          onClick={() => void health.refetch()}
        >
          <i className="bi bi-arrow-clockwise me-1" aria-hidden="true" />
          {t('system.health.refresh')}
        </button>
      </div>
      <p className="cb-text-secondary">
        {t('system.health.subtitle', { seconds: HEALTH_REFRESH_MS / 1000 })}
        {health.dataUpdatedAt > 0 && (
          <>
            {' '}
            {t('system.health.updatedAt', { time: time.format(new Date(health.dataUpdatedAt)) })}
          </>
        )}
      </p>
      {health.isPending && <LoadingRow />}
      <ErrorAlert error={health.isError ? consoleError(t, health.error) : null} />
      {data && (
        <>
          <p className="d-flex flex-wrap align-items-center gap-2 small">
            <span className={`badge ${ENV_BADGE[data.env.toLowerCase()] ?? 'text-bg-secondary'}`}>
              {t('system.health.env', { env: data.env.toUpperCase() })}
            </span>
            <span>{t('system.health.apiVersion', { version: data.version })}</span>
          </p>
          {data.maintenance.enabled && (
            <div className="alert alert-warning" role="status">
              <i className="bi bi-cone-striped me-1" aria-hidden="true" />
              {t('system.health.maintenanceOn')}
              {data.maintenance.message && (
                <span className="d-block small">“{data.maintenance.message}”</span>
              )}
            </div>
          )}
          <div className="row g-3 mb-3">
            <div className="col-lg-6">
              <section
                className="p-3 border cb-border rounded-3 bg-white h-100"
                aria-labelledby="deps-h"
              >
                <h2 id="deps-h" className="h6">
                  {t('system.health.dependencies')}
                </h2>
                <ul className="list-unstyled small mb-0">
                  {data.dependencies.map((d) => (
                    <li
                      key={d.name}
                      className="d-flex justify-content-between align-items-center gap-2 mb-1"
                    >
                      <span className="fw-semibold">{d.name}</span>
                      <span>
                        {d.latencyMs !== null && (
                          <span className="cb-text-secondary me-2">
                            {t('ai.health.ms', { value: Math.round(d.latencyMs) })}
                          </span>
                        )}
                        <OkBadge ok={d.ok} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
            <div className="col-lg-6">
              <Sessions sessions={data.sessions} />
            </div>
          </div>
          <Workers workers={data.workers} />
          <section className="border cb-border rounded-3 bg-white" aria-labelledby="queues-h">
            <div className="p-3 pb-0 d-flex justify-content-between align-items-center">
              <h2 id="queues-h" className="h6">
                {t('system.health.queues')}
              </h2>
              <Link to="/system/queues" className="small">
                {t('system.health.openQueues')}
              </Link>
            </div>
            <QueueCountsTable queues={data.queues} />
          </section>
        </>
      )}
    </>
  );
}
