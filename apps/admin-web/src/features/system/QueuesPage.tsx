import type { FailedJob } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { FAILED_JOBS_LIMIT, systemKeys, useFailedJobs, useQueues } from './queries';
import { QueueCountsTable } from './shared';

function FailedJobs({ queue }: { queue: string }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const canRetry = useCan('queues.manage');
  const failed = useFailedJobs(queue);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: systemKeys.failed(queue) }),
      queryClient.invalidateQueries({ queryKey: systemKeys.queues }),
      queryClient.invalidateQueries({ queryKey: systemKeys.health }),
    ]);

  const retry = useMutation({
    mutationFn: ({ job, reason }: { job: FailedJob; reason: string }) =>
      manager.api.post<{ retried: boolean }>(
        `/admin/system/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(job.id)}/retry`,
        { reason },
      ),
    onSuccess: async (_result, { job }) => {
      setRetrying(null);
      setError(null);
      setNotice({ tone: 'success', text: t('system.queues.retried', { id: job.id }) });
      await refresh();
    },
    onError: async (err, { job }) => {
      if (err instanceof ApiClientError && err.status === 404) {
        // Retried by someone else, or removed: the list is out of date.
        setRetrying(null);
        setError(null);
        setNotice({ tone: 'warning', text: t('system.queues.goneRefreshed', { id: job.id }) });
        await refresh();
        return;
      }
      setError(consoleError(t, err));
    },
  });

  const jobs = failed.data ?? [];
  return (
    <section className="border cb-border rounded-3 bg-white mt-3" aria-labelledby={`${id}-heading`}>
      <div className="p-3 pb-0 d-flex flex-wrap justify-content-between align-items-center gap-2">
        <h2 id={`${id}-heading`} className="h5 mb-0">
          {t('system.queues.failedTitle', { name: queue })}
        </h2>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          disabled={failed.isFetching}
          onClick={() => void refresh()}
        >
          <i className="bi bi-arrow-clockwise me-1" aria-hidden="true" />
          {t('system.health.refresh')}
        </button>
      </div>
      <div className="px-3 pt-2">
        <p className="small cb-text-secondary">
          {t('system.queues.failedExplain', { limit: FAILED_JOBS_LIMIT })}
        </p>
        <div role="status" aria-live="polite">
          {notice && <div className={`alert alert-${notice.tone} py-2`}>{notice.text}</div>}
        </div>
      </div>
      {failed.isPending && <LoadingRow />}
      <div className="px-3">
        <ErrorAlert error={failed.isError ? consoleError(t, failed.error) : null} />
      </div>
      {failed.data && (
        <div className="table-responsive">
          <table className="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th scope="col">{t('system.queues.job')}</th>
                <th scope="col">{t('system.queues.reason')}</th>
                <th scope="col" className="text-end">
                  {t('system.queues.attempts')}
                </th>
                <th scope="col">{t('system.queues.failedAt')}</th>
                <th scope="col">{t('system.queues.data')}</th>
                {canRetry && (
                  <th scope="col">
                    <span className="visually-hidden">{t('system.queues.actions')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={canRetry ? 6 : 5} className="cb-text-secondary">
                    {t('system.queues.noFailed')}
                  </td>
                </tr>
              )}
              {jobs.map((job) => (
                <Fragment key={job.id}>
                  <tr>
                    <th scope="row" className="fw-normal small">
                      <code>{job.id}</code>
                      <span className="d-block cb-text-secondary">{job.name}</span>
                    </th>
                    <td className="small text-break" style={{ maxWidth: '24rem' }}>
                      {job.failedReason || '—'}
                    </td>
                    <td className="text-end small">{job.attemptsMade}</td>
                    <td className="small text-nowrap">
                      {job.failedAt ? formatDateTime(job.failedAt, i18n.language) : '—'}
                    </td>
                    <td className="small">
                      <code className="text-break">{JSON.stringify(job.data)}</code>
                    </td>
                    {canRetry && (
                      <td className="text-end">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary"
                          disabled={retrying !== null}
                          aria-label={t('system.queues.retryJob', { id: job.id })}
                          onClick={() => {
                            setNotice(null);
                            setError(null);
                            setRetrying(job.id);
                          }}
                        >
                          {t('system.queues.retry')}
                        </button>
                      </td>
                    )}
                  </tr>
                  {retrying === job.id && (
                    <tr>
                      <td colSpan={6}>
                        <ReasonForm
                          submitLabel={t('system.queues.confirmRetry')}
                          pending={retry.isPending}
                          error={error}
                          onSubmit={(reason) => retry.mutate({ job, reason })}
                          onCancel={() => {
                            setRetrying(null);
                            setError(null);
                          }}
                        >
                          <p className="fw-semibold mb-1">
                            {t('system.queues.retryExplain', { id: job.id, name: queue })}
                          </p>
                        </ReasonForm>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function QueuesPage() {
  const { t } = useTranslation();
  const queues = useQueues();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <h1 className="h3 mb-2">{t('system.queues.title')}</h1>
      <p className="cb-text-secondary">{t('system.queues.subtitle')}</p>
      {queues.isPending && <LoadingRow />}
      <ErrorAlert error={queues.isError ? consoleError(t, queues.error) : null} />
      {queues.data && (
        <section
          className="border cb-border rounded-3 bg-white"
          aria-label={t('system.queues.listLabel')}
        >
          <QueueCountsTable
            queues={queues.data}
            selected={selected}
            onShowFailed={(name) => setSelected(name)}
          />
        </section>
      )}
      {selected && <FailedJobs key={selected} queue={selected} />}
    </>
  );
}
