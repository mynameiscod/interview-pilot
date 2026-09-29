import {
  ApplicationStatus,
  CandidateStage,
  type BulkStageChangeResult,
  type CampaignSummary,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ErrorAlert, LoadingRow } from '../features/ai/shared';
import { consoleError } from '../features/ai/format';
import { downloadExport } from '../features/campaigns/format';
import { ApplicationStatusBadge, Pager } from '../features/campaigns/shared';
import {
  EMPTY_FILTERS,
  orgKeys,
  queryString,
  useOrgResults,
  type PipelineFilters,
} from './queries';
import { useOrgAuth, useOrgCan } from './session';
import { IdentityBadge, StageBadge } from './shared';

/**
 * The candidate pipeline: consenting candidates only, with stage, scores,
 * scorecards and the identity check; filters by status, stage, score,
 * dimension and scorecard; bulk stage changes and the CSV export.
 */
export function OrgCandidatesSection({ campaign }: { campaign: CampaignSummary }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const canMove = useOrgCan('org.pipeline.manage');
  const canExport = useOrgCan('org.export');
  const [draft, setDraft] = useState<PipelineFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<PipelineFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStage, setBulkStage] = useState<CandidateStage>('SHORTLISTED');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const results = useOrgResults(campaign.id, filters, page);
  const dimensions = results.data?.dimensions ?? [];
  const rows = results.data?.rows ?? [];

  const toggle = (appId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });

  async function moveSelected() {
    setBusy(true);
    setError(null);
    try {
      const result = await manager.api.post<BulkStageChangeResult>(
        `/org/campaigns/${campaign.id}/candidates/stage`,
        { stage: bulkStage, note: null, applicationIds: [...selected] },
      );
      setMessage(t('orgPortal.pipeline.moved', { count: result.changed }));
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: orgKeys.results(campaign.id) });
    } catch (err) {
      setError(consoleError(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      const { sort, ...rest } = filters;
      await downloadExport(
        manager,
        `/org/campaigns/${campaign.id}/results.csv${queryString({ ...rest, sort })}`,
        `campaign-${campaign.id}-candidates.csv`,
      );
    } catch (err) {
      setError(consoleError(t, err));
    } finally {
      setBusy(false);
    }
  }

  const stageCounts = results.data?.stages;
  const field = (key: string) => `${id}-${key}`;

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="h5">
        {t('orgPortal.pipeline.title')}
      </h2>
      <p className="small cb-text-secondary">{t('orgPortal.pipeline.consentNote')}</p>
      {stageCounts && (
        <ul className="list-inline mb-3" aria-label={t('orgPortal.pipeline.board')}>
          {CandidateStage.options.map((stage) => (
            <li key={stage} className="list-inline-item">
              <button
                type="button"
                className={`btn btn-sm ${filters.stage === stage ? 'btn-primary' : 'btn-outline-secondary'}`}
                aria-pressed={filters.stage === stage}
                onClick={() => {
                  const next = { ...filters, stage: filters.stage === stage ? '' : stage };
                  setDraft(next);
                  setFilters(next);
                  setPage(1);
                }}
              >
                {t(`orgPortal.stages.${stage}`)}{' '}
                <span className="badge text-bg-light">{stageCounts[stage]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row g-2 align-items-end mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
          setPage(1);
        }}
      >
        <div className="col-sm-4 col-lg-2">
          <label htmlFor={field('status')} className="form-label small">
            {t('orgPortal.pipeline.status')}
          </label>
          <select
            id={field('status')}
            className="form-select form-select-sm"
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          >
            <option value="">{t('orgPortal.pipeline.any')}</option>
            {ApplicationStatus.options.map((s) => (
              <option key={s} value={s}>
                {t(`campaigns.applicationStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-sm-4 col-lg-2">
          <label htmlFor={field('minOverall')} className="form-label small">
            {t('orgPortal.pipeline.minOverall')}
          </label>
          <input
            id={field('minOverall')}
            type="number"
            min={0}
            max={100}
            className="form-control form-control-sm"
            value={draft.minOverall}
            onChange={(e) => setDraft({ ...draft, minOverall: e.target.value })}
          />
        </div>
        <div className="col-sm-4 col-lg-2">
          <label htmlFor={field('minScorecard')} className="form-label small">
            {t('orgPortal.pipeline.minScorecard')}
          </label>
          <input
            id={field('minScorecard')}
            type="number"
            min={1}
            max={5}
            step={0.5}
            className="form-control form-control-sm"
            value={draft.minScorecard}
            onChange={(e) => setDraft({ ...draft, minScorecard: e.target.value })}
          />
        </div>
        <div className="col-sm-6 col-lg-3">
          <label htmlFor={field('dimension')} className="form-label small">
            {t('orgPortal.pipeline.dimension')}
          </label>
          <div className="input-group input-group-sm">
            <select
              id={field('dimension')}
              className="form-select"
              value={draft.dimension.split(':')[0] ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  dimension: e.target.value
                    ? `${e.target.value}:${draft.dimension.split(':')[1] || '60'}`
                    : '',
                })
              }
            >
              <option value="">{t('orgPortal.pipeline.any')}</option>
              {dimensions.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              max={100}
              className="form-control"
              aria-label={t('orgPortal.pipeline.dimensionMin')}
              disabled={!draft.dimension}
              value={draft.dimension.split(':')[1] ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  dimension: `${draft.dimension.split(':')[0]}:${e.target.value.replace(/\D/g, '') || '0'}`,
                })
              }
            />
          </div>
        </div>
        <div className="col-sm-6 col-lg-3 d-flex gap-2">
          <button type="submit" className="btn btn-sm btn-primary">
            {t('orgPortal.pipeline.apply')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setFilters(EMPTY_FILTERS);
              setPage(1);
            }}
          >
            {t('orgPortal.pipeline.clear')}
          </button>
          {canExport && (
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={busy}
              onClick={() => void exportCsv()}
            >
              <i className="bi bi-filetype-csv me-1" aria-hidden="true" />
              {t('orgPortal.pipeline.csv')}
            </button>
          )}
        </div>
      </form>
      {canMove && selected.size > 0 && (
        <div className="d-flex flex-wrap align-items-center gap-2 p-2 mb-2 cb-surface-muted rounded-2">
          <span className="small">
            {t('orgPortal.pipeline.selected', { count: selected.size })}
          </span>
          <label htmlFor={field('bulkStage')} className="visually-hidden">
            {t('orgPortal.pipeline.moveTo')}
          </label>
          <select
            id={field('bulkStage')}
            className="form-select form-select-sm w-auto"
            value={bulkStage}
            onChange={(e) => setBulkStage(e.target.value as CandidateStage)}
          >
            {CandidateStage.options.map((s) => (
              <option key={s} value={s}>
                {t(`orgPortal.stages.${s}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void moveSelected()}
          >
            {t('orgPortal.pipeline.moveSelected')}
          </button>
        </div>
      )}
      <div role="status" aria-live="polite" className="small mb-2">
        {message}
      </div>
      <ErrorAlert error={error} />
      {results.isPending ? (
        <LoadingRow />
      ) : results.isError ? (
        <ErrorAlert error={consoleError(t, results.error)} />
      ) : rows.length === 0 ? (
        <p className="p-3 border cb-border rounded-3 bg-white">{t('orgPortal.pipeline.empty')}</p>
      ) : (
        <div className="table-responsive border cb-border rounded-3 bg-white">
          <table className="table table-sm align-middle mb-0">
            <caption className="visually-hidden">{t('orgPortal.pipeline.title')}</caption>
            <thead>
              <tr>
                {canMove && (
                  <th scope="col">
                    <span className="visually-hidden">{t('orgPortal.pipeline.select')}</span>
                  </th>
                )}
                <th scope="col">{t('orgPortal.pipeline.candidate')}</th>
                <th scope="col">{t('orgPortal.pipeline.status')}</th>
                <th scope="col">{t('orgPortal.pipeline.stage')}</th>
                <th scope="col">{t('orgPortal.pipeline.overall')}</th>
                {dimensions.map((d) => (
                  <th scope="col" key={d.key}>
                    {d.name}
                  </th>
                ))}
                <th scope="col">{t('orgPortal.pipeline.scorecard')}</th>
                {campaign.idCapture && <th scope="col">{t('orgPortal.pipeline.identity')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.applicationId}>
                  {canMove && (
                    <td>
                      <input
                        type="checkbox"
                        className="form-check-input"
                        aria-label={t('orgPortal.pipeline.selectOne', {
                          name: row.candidate.name ?? row.candidate.email ?? row.applicationId,
                        })}
                        checked={selected.has(row.applicationId)}
                        onChange={() => toggle(row.applicationId)}
                      />
                    </td>
                  )}
                  <td>
                    <Link to={`/org/campaigns/${campaign.id}/candidates/${row.applicationId}`}>
                      {row.candidate.name ?? row.candidate.email ?? t('orgPortal.pipeline.unnamed')}
                    </Link>
                    <div className="small cb-text-secondary">{row.candidate.email}</div>
                  </td>
                  <td>
                    <ApplicationStatusBadge status={row.status} />
                  </td>
                  <td>
                    <StageBadge stage={row.stage} />
                  </td>
                  <td>{row.overall ?? '—'}</td>
                  {dimensions.map((d) => (
                    <td key={d.key}>{row.dimensions[d.key] ?? '—'}</td>
                  ))}
                  <td>
                    {row.scorecardAverage === null
                      ? '—'
                      : t('orgPortal.pipeline.scorecardValue', {
                          average: row.scorecardAverage,
                          count: row.scorecards,
                        })}
                  </td>
                  {campaign.idCapture && (
                    <td>
                      <IdentityBadge status={row.identity} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {results.data && (
        <Pager
          page={page}
          pageSize={results.data.pageSize}
          total={results.data.total}
          onPage={setPage}
          disabled={results.isFetching}
        />
      )}
    </section>
  );
}
