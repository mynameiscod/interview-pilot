import type { AuditLogPage as AuditLogPageData } from '@cbi/shared-types';
import { errorMessage } from '@cbi/web-core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { downloadExport } from '../campaigns/format';
import { auditParams, NO_FILTERS, type AuditFilters } from './params';

export function AuditLogPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const canExport = useCan('audit.export');
  const [form, setForm] = useState<AuditFilters>(NO_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const [rangeError, setRangeError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const logs = useInfiniteQuery({
    queryKey: ['audit-logs', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = auditParams(filters);
      params.set('limit', '50');
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
    const invalid = Boolean(form.fromDay && form.toDay && form.fromDay > form.toDay);
    setRangeError(invalid);
    if (!invalid) setFilters(form);
  }

  function clearFilters() {
    setForm(NO_FILTERS);
    setFilters(NO_FILTERS);
    setRangeError(false);
  }

  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const qs = auditParams(filters).toString();
      await downloadExport(
        manager,
        `/admin/audit-logs/export.csv${qs ? `?${qs}` : ''}`,
        'audit-log.csv',
      );
    } catch (err) {
      setExportError(errorMessage(t, err));
    } finally {
      setExporting(false);
    }
  }

  const field = (key: keyof AuditFilters, label: string, extra: object = {}) => (
    <div>
      <label htmlFor={`${id}-${key}`} className="form-label small mb-1">
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        className="form-control"
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...extra}
      />
    </div>
  );

  return (
    <>
      <h1 className="h3 mb-2">{t('audit.title')}</h1>
      <p className="cb-text-secondary">{t('audit.subtitle')}</p>
      <form
        className="d-flex flex-wrap gap-2 align-items-end mb-3"
        onSubmit={applyFilter}
        aria-label={t('auditTools.filtersLabel')}
      >
        {field('action', t('audit.actionFilter'), { placeholder: 'auth.login_succeeded' })}
        {field('actorId', t('auditTools.actorId'), { className: 'form-control font-monospace' })}
        {field('resourceId', t('auditTools.resourceId'), {
          className: 'form-control font-monospace',
        })}
        {field('fromDay', t('auditTools.from'), { type: 'date' })}
        {field('toDay', t('auditTools.to'), { type: 'date' })}
        <button type="submit" className="btn btn-outline-primary">
          {t('audit.apply')}
        </button>
        <button type="button" className="btn btn-link" onClick={clearFilters}>
          {t('auditTools.clear')}
        </button>
        {canExport && (
          <button
            type="button"
            className="btn btn-outline-secondary ms-auto"
            onClick={() => void exportCsv()}
            disabled={exporting}
          >
            <i className="bi bi-download me-1" aria-hidden="true" />
            {exporting ? t('auditTools.exporting') : t('auditTools.export')}
          </button>
        )}
      </form>
      {rangeError && (
        <div className="alert alert-warning py-2" role="alert">
          {t('auditTools.rangeInvalid')}
        </div>
      )}
      {exportError && (
        <div className="alert alert-danger py-2" role="alert">
          {exportError}
        </div>
      )}
      {canExport && <p className="small cb-text-secondary">{t('auditTools.exportHint')}</p>}

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
