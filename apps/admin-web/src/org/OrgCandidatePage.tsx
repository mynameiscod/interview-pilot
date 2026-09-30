import {
  API_V1_PREFIX,
  CandidateStage,
  Recommendation,
  type IdentityReview,
  type OrgCandidateDetail,
} from '@cbi/shared-types';
import type { SessionManager } from '@cbi/web-core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { config } from '../config';
import { consoleError } from '../features/ai/format';
import { ErrorAlert, LoadingRow } from '../features/ai/shared';
import { ApplicationStatusBadge } from '../features/campaigns/shared';
import { formatDateTime } from '../features/library/format';
import { orgKeys, useOrgCandidate } from './queries';
import { useOrgAuth, useOrgCan } from './session';
import { IdentityBadge, StageBadge } from './shared';

/** An image behind the bearer token, as an object URL (revoked when the component goes). */
function useAuthedImage(manager: SessionManager, path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path) return;
    let active = true;
    let objectUrl: string | null = null;
    const load = async () => {
      const send = (token: string | null) =>
        fetch(`${config.apiUrl}${API_V1_PREFIX}${path}`, {
          credentials: 'include',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      let res = await send(manager.current?.accessToken ?? null);
      if (res.status === 401) res = await send((await manager.refresh())?.accessToken ?? null);
      if (!res.ok) throw new Error(`image ${res.status}`);
      objectUrl = URL.createObjectURL(await res.blob());
      if (active) setUrl(objectUrl);
    };
    load().catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [manager, path]);
  return { url, failed };
}

function IdentityImage({ path, label }: { path: string | null; label: string }) {
  const { t } = useTranslation();
  const { manager } = useOrgAuth();
  const { url, failed } = useAuthedImage(manager, path);
  return (
    <figure className="col-md-4 mb-2">
      <div
        className="border cb-border rounded-2 cb-surface-muted d-flex align-items-center justify-content-center"
        style={{ aspectRatio: '4 / 3', overflow: 'hidden' }}
      >
        {!path ? (
          <span className="small cb-text-secondary">{t('orgPortal.identity.notCaptured')}</span>
        ) : failed ? (
          <span className="small text-danger">{t('orgPortal.identity.loadFailed')}</span>
        ) : url ? (
          <img src={url} alt={label} className="w-100 h-100" style={{ objectFit: 'contain' }} />
        ) : (
          <span className="small">{t('common.loading')}</span>
        )}
      </div>
      <figcaption className="small text-center mt-1">{label}</figcaption>
    </figure>
  );
}

function IdentityPanel({
  identity,
  campaignId,
  applicationId,
}: {
  identity: IdentityReview | null;
  campaignId: string;
  applicationId: string;
}) {
  const { t } = useTranslation();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const canDecide = useOrgCan('org.pipeline.manage');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'VERIFIED' | 'MISMATCH') {
    setError(null);
    try {
      await manager.api.post(
        `/org/campaigns/${campaignId}/candidates/${applicationId}/identity/review`,
        { decision, note: note.trim() || null },
      );
      await queryClient.invalidateQueries({
        queryKey: orgKeys.candidate(campaignId, applicationId),
      });
      await queryClient.invalidateQueries({ queryKey: orgKeys.results(campaignId) });
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby="org-identity"
    >
      <h2 id="org-identity" className="h6">
        {t('orgPortal.identity.title')} <IdentityBadge status={identity?.status ?? 'NONE'} />
      </h2>
      <p className="small cb-text-secondary">{t('orgPortal.identity.manualOnly')}</p>
      {!identity ? (
        <p className="mb-0">{t('orgPortal.identity.none')}</p>
      ) : (
        <>
          <div className="row">
            <IdentityImage
              path={identity.imagePaths.selfie}
              label={t('orgPortal.identity.selfie')}
            />
            <IdentityImage
              path={identity.imagePaths.idDocument}
              label={t('orgPortal.identity.idDocument')}
            />
            <IdentityImage
              path={identity.imagePaths.interviewFrame}
              label={t('orgPortal.identity.interviewFrame')}
            />
          </div>
          {identity.decision && (
            <p className="small">
              {t('orgPortal.identity.decided', {
                decision: t(`orgPortal.identity.${identity.decision.decision}`),
              })}
              {identity.decision.note ? ` — ${identity.decision.note}` : ''}
            </p>
          )}
          {canDecide && identity.imagePaths.selfie && identity.imagePaths.idDocument && (
            <div className="d-flex flex-wrap gap-2 align-items-end">
              <div className="flex-grow-1">
                <label htmlFor="org-identity-note" className="form-label small">
                  {t('orgPortal.identity.note')}
                </label>
                <input
                  id="org-identity-note"
                  className="form-control form-control-sm"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-sm btn-success"
                onClick={() => void decide('VERIFIED')}
              >
                {t('orgPortal.identity.markVerified')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                onClick={() => void decide('MISMATCH')}
              >
                {t('orgPortal.identity.markMismatch')}
              </button>
            </div>
          )}
          <ErrorAlert error={error} />
        </>
      )}
    </section>
  );
}

function ScorecardForm({ detail, campaignId }: { detail: OrgCandidateDetail; campaignId: string }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager, user } = useOrgAuth();
  const queryClient = useQueryClient();
  const mine = detail.scorecards.find((s) => s.reviewer.userId === user?.id);
  const [ratings, setRatings] = useState<Record<string, number>>(mine?.ratings ?? {});
  const [recommendation, setRecommendation] = useState<Recommendation>(
    mine?.recommendation ?? 'YES',
  );
  const [comment, setComment] = useState(mine?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await manager.api.put(
        `/org/campaigns/${campaignId}/candidates/${detail.row.applicationId}/scorecard`,
        { ratings, recommendation, comment: comment.trim() || null },
      );
      setSaved(true);
      await queryClient.invalidateQueries({
        queryKey: orgKeys.candidate(campaignId, detail.row.applicationId),
      });
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="h6">
        {t('orgPortal.scorecard.yours')}
      </h3>
      {detail.criteria.map((c) => (
        <fieldset key={c.key} className="mb-2">
          <legend className="small fw-semibold mb-1">{c.label}</legend>
          {[1, 2, 3, 4, 5].map((n) => (
            <div className="form-check form-check-inline" key={n}>
              <input
                id={`${id}-${c.key}-${n}`}
                type="radio"
                className="form-check-input"
                name={`${id}-${c.key}`}
                checked={ratings[c.key] === n}
                onChange={() => setRatings((r) => ({ ...r, [c.key]: n }))}
              />
              <label htmlFor={`${id}-${c.key}-${n}`} className="form-check-label small">
                {n}
              </label>
            </div>
          ))}
        </fieldset>
      ))}
      <label htmlFor={`${id}-rec`} className="form-label small">
        {t('orgPortal.scorecard.recommendation')}
      </label>
      <select
        id={`${id}-rec`}
        className="form-select form-select-sm mb-2"
        value={recommendation}
        onChange={(e) => setRecommendation(e.target.value as Recommendation)}
      >
        {Recommendation.options.map((r) => (
          <option key={r} value={r}>
            {t(`orgPortal.scorecard.recommendations.${r}`)}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-comment`} className="form-label small">
        {t('orgPortal.scorecard.comment')}
      </label>
      <textarea
        id={`${id}-comment`}
        rows={2}
        className="form-control form-control-sm mb-2"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <ErrorAlert error={error} />
      <button
        type="submit"
        className="btn btn-sm btn-primary"
        disabled={detail.criteria.some((c) => !ratings[c.key])}
      >
        {t('orgPortal.scorecard.save')}
      </button>
      <span role="status" className="small ms-2">
        {saved ? t('orgPortal.scorecard.saved') : ''}
      </span>
    </form>
  );
}

export function OrgCandidatePage() {
  const { t, i18n } = useTranslation();
  const { campaignId = '', applicationId = '' } = useParams();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const canMove = useOrgCan('org.pipeline.manage');
  const canReview = useOrgCan('org.review');
  const detail = useOrgCandidate(campaignId, applicationId);
  const [stage, setStage] = useState<CandidateStage | ''>('');
  const [stageNote, setStageNote] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (detail.isPending) return <LoadingRow />;
  if (detail.isError) return <ErrorAlert error={consoleError(t, detail.error)} />;
  const d = detail.data;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orgKeys.candidate(campaignId, applicationId) }),
      queryClient.invalidateQueries({ queryKey: orgKeys.results(campaignId) }),
    ]);

  async function moveStage(e: FormEvent) {
    e.preventDefault();
    if (!stage) return;
    setError(null);
    try {
      await manager.api.post(`/org/campaigns/${campaignId}/candidates/${applicationId}/stage`, {
        stage,
        note: stageNote.trim() || null,
      });
      setStage('');
      setStageNote('');
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    setError(null);
    try {
      await manager.api.post(`/org/campaigns/${campaignId}/candidates/${applicationId}/notes`, {
        body: note.trim(),
      });
      setNote('');
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  const row = d.row;
  return (
    <>
      <nav aria-label={t('orgPortal.breadcrumb')} className="small mb-2">
        <Link to="/org">{t('orgPortal.nav.campaigns')}</Link> ›{' '}
        <Link to={`/org/campaigns/${campaignId}`}>{t('orgPortal.candidate.backToCampaign')}</Link>
      </nav>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
        <h1 className="h3 mb-0">{row.candidate.name ?? row.candidate.email}</h1>
        <ApplicationStatusBadge status={row.status} />
        <StageBadge stage={row.stage} />
      </div>
      <p className="cb-text-secondary">{row.candidate.email}</p>
      <ErrorAlert error={error} />
      <div className="row g-3">
        <div className="col-lg-7">
          <section
            className="p-3 border cb-border rounded-3 bg-white mb-3"
            aria-labelledby="org-scores"
          >
            <h2 id="org-scores" className="h6">
              {t('orgPortal.candidate.scores')}
            </h2>
            <p className="mb-2">
              {t('orgPortal.candidate.overall', { score: row.overall ?? '—' })}
              {row.band && ` · ${t(`orgPortal.bands.${row.band}`, { defaultValue: row.band })}`}
            </p>
            <ul className="list-unstyled small mb-0">
              {Object.entries(row.dimensions).map(([key, score]) => (
                <li key={key}>
                  {key}: {score ?? '—'}
                </li>
              ))}
            </ul>
          </section>
          {d.report ? (
            <section
              className="p-3 border cb-border rounded-3 bg-white mb-3"
              aria-labelledby="org-report"
            >
              <h2 id="org-report" className="h6">
                {t('orgPortal.candidate.report')}
              </h2>
              {d.report.summary && <p>{d.report.summary}</p>}
              {d.report.strengths.length > 0 && (
                <>
                  <h3 className="h6">{t('orgPortal.candidate.strengths')}</h3>
                  <ul>
                    {d.report.strengths.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
              {d.report.gaps.length > 0 && (
                <>
                  <h3 className="h6">{t('orgPortal.candidate.gaps')}</h3>
                  <ul>
                    {d.report.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </>
              )}
              {d.report.transcript.length > 0 && (
                <details>
                  <summary>{t('orgPortal.candidate.transcript')}</summary>
                  <ol className="small mt-2">
                    {d.report.transcript.map((turn, i) => (
                      <li key={i} className="mb-2">
                        <div className="fw-semibold">{turn.question}</div>
                        <div>{turn.answer ?? '—'}</div>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </section>
          ) : (
            <p className="small cb-text-secondary">{t('orgPortal.candidate.scoresOnly')}</p>
          )}
          {d.identity !== null || row.identity !== 'NONE' ? (
            <IdentityPanel
              identity={d.identity}
              campaignId={campaignId}
              applicationId={applicationId}
            />
          ) : null}
        </div>
        <div className="col-lg-5">
          {canMove && (
            <form
              className="p-3 border cb-border rounded-3 bg-white mb-3"
              onSubmit={(e) => void moveStage(e)}
              aria-labelledby="org-stage"
            >
              <h2 id="org-stage" className="h6">
                {t('orgPortal.candidate.stage')}
              </h2>
              <label htmlFor="org-stage-select" className="visually-hidden">
                {t('orgPortal.pipeline.moveTo')}
              </label>
              <select
                id="org-stage-select"
                className="form-select form-select-sm mb-2"
                value={stage}
                onChange={(e) => setStage(e.target.value as CandidateStage)}
              >
                <option value="">{t('orgPortal.pipeline.moveTo')}</option>
                {CandidateStage.options
                  .filter((s) => s !== row.stage)
                  .map((s) => (
                    <option key={s} value={s}>
                      {t(`orgPortal.stages.${s}`)}
                    </option>
                  ))}
              </select>
              <label htmlFor="org-stage-note" className="form-label small">
                {t('orgPortal.candidate.stageNote')}
              </label>
              <input
                id="org-stage-note"
                className="form-control form-control-sm mb-2"
                value={stageNote}
                onChange={(e) => setStageNote(e.target.value)}
              />
              <button type="submit" className="btn btn-sm btn-primary" disabled={!stage}>
                {t('orgPortal.candidate.move')}
              </button>
              {d.stageHistory.length > 0 && (
                <ul className="small mt-2 mb-0">
                  {d.stageHistory.map((e, i) => (
                    <li key={i}>
                      {t('orgPortal.candidate.history', {
                        from: t(`orgPortal.stages.${e.from}`),
                        to: t(`orgPortal.stages.${e.to}`),
                        at: formatDateTime(e.at, i18n.language),
                      })}
                      {e.note ? ` — ${e.note}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </form>
          )}
          <section
            className="p-3 border cb-border rounded-3 bg-white mb-3"
            aria-labelledby="org-scorecards"
          >
            <h2 id="org-scorecards" className="h6">
              {t('orgPortal.scorecard.title')}
            </h2>
            {d.scorecards.length === 0 ? (
              <p className="small">{t('orgPortal.scorecard.none')}</p>
            ) : (
              <ul className="list-unstyled small">
                {d.scorecards.map((s) => (
                  <li key={s.id} className="mb-2">
                    <span className="fw-semibold">{s.reviewer.name ?? s.reviewer.email}</span>:{' '}
                    {t('orgPortal.scorecard.summary', {
                      average: s.average,
                      recommendation: t(`orgPortal.scorecard.recommendations.${s.recommendation}`),
                    })}
                    {s.comment && <div className="cb-text-secondary">{s.comment}</div>}
                  </li>
                ))}
              </ul>
            )}
            {canReview && (
              <ScorecardForm key={d.scorecards.length} detail={d} campaignId={campaignId} />
            )}
          </section>
          <section className="p-3 border cb-border rounded-3 bg-white" aria-labelledby="org-notes">
            <h2 id="org-notes" className="h6">
              {t('orgPortal.notes.title')}
            </h2>
            <ul className="list-unstyled small">
              {d.notes.map((n) => (
                <li key={n.id} className="mb-2">
                  <div className="fw-semibold">
                    {n.author.name ?? n.author.email} ·{' '}
                    <span className="fw-normal cb-text-secondary">
                      {formatDateTime(n.createdAt, i18n.language)}
                    </span>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                </li>
              ))}
            </ul>
            {canReview && (
              <form onSubmit={(e) => void addNote(e)}>
                <label htmlFor="org-note" className="form-label small">
                  {t('orgPortal.notes.add')}
                </label>
                <textarea
                  id="org-note"
                  rows={3}
                  className="form-control form-control-sm mb-1"
                  aria-describedby="org-note-hint"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div id="org-note-hint" className="form-text mb-2">
                  {t('orgPortal.notes.mentionsHint')}
                </div>
                <button type="submit" className="btn btn-sm btn-primary" disabled={!note.trim()}>
                  {t('orgPortal.notes.save')}
                </button>
              </form>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
