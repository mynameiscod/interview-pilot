import type { AuditLogPage as AuditLogPageData } from '@cbi/shared-types';
import { errorMessage } from '@cbi/web-core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';

export function AuditLogPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const [actionInput, setActionInput] = useState('');
  const [action, setAction] = useState('');

  const logs = useInfiniteQuery({
    queryKey: ['audit-logs', action],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (action) params.set('action', action);
      if (pageParam) params.set('before', pageParam);
      return manager.api.get<AuditLogPageData>(`/admin/audit-logs?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
  const rows = logs.data?.pages.flatMap((p) => p.items) ?? [];

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setAction(actionInput.trim());
  }

  return (
    <>
      <h1 className="h3 mb-2">{t('audit.title')}</h1>
      <p className="cb-text-secondary">{t('audit.subtitle')}</p>
      <form className="d-flex flex-wrap gap-2 align-items-end mb-3" onSubmit={applyFilter}>
        <div>
          <label htmlFor={`${id}-action`} className="form-label small mb-1">
            {t('audit.actionFilter')}
          </label>
          <input
            id={`${id}-action`}
            className="form-control"
            placeholder="auth.login_succeeded"
            value={actionInput}
            onChange={(e) => setActionInput(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-outline-primary">
          {t('audit.apply')}
        </button>
      </form>

      <section className="border cb-border rounded-3 bg-white" aria-label={t('audit.title')}>
        {logs.isPending && (
          <div className="p-4" role="status">
            {t('common.loading')}
          </div>
        )}
        {logs.isError && (
          <div className="alert alert-danger m-3" role="alert">
            {errorMessage(t, logs.error)}
          </div>
        )}
        {logs.data && rows.length === 0 && <p className="p-4 mb-0">{t('audit.empty')}</p>}
        {rows.length > 0 && (
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('audit.time')}</th>
                  <th scope="col">{t('audit.action')}</th>
                  <th scope="col">{t('audit.actor')}</th>
                  <th scope="col">{t('audit.resource')}</th>
                  <th scope="col">{t('audit.outcome')}</th>
                  <th scope="col">{t('audit.details')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="small text-nowrap">{format.format(new Date(row.at))}</td>
                    <td>
                      <code>{row.action}</code>
                    </td>
                    <td className="small">
                      {t(`audit.actorTypes.${row.actorType}`)}
                      {row.actorId && (
                        <div className="font-monospace cb-text-secondary">{row.actorId}</div>
                      )}
                    </td>
                    <td className="small font-monospace">
                      {row.resourceType ? `${row.resourceType}:${row.resourceId}` : '—'}
                    </td>
                    <td>
                      <span
                        className={`badge ${row.outcome === 'SUCCESS' ? 'text-bg-success' : 'text-bg-danger'}`}
                      >
                        <i
                          className={`bi ${row.outcome === 'SUCCESS' ? 'bi-check-lg' : 'bi-x-lg'} me-1`}
                          aria-hidden="true"
                        />
                        {t(`audit.outcomes.${row.outcome}`)}
                      </span>
                    </td>
                    <td className="small font-monospace text-break" style={{ maxWidth: '24rem' }}>
                      {row.details ? JSON.stringify(row.details) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {logs.hasNextPage && (
        <button
          type="button"
          className="btn btn-outline-primary mt-3"
          onClick={() => void logs.fetchNextPage()}
          disabled={logs.isFetchingNextPage}
        >
          {t('audit.loadMore')}
        </button>
      )}
    </>
  );
}
