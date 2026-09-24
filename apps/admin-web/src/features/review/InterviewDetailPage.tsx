import type {
  AdminInterviewDetail,
  AdminInterviewRow,
  ScoreRevisionSummary,
} from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { formatMicros } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { campaignError } from '../campaigns/format';
import { formatDateTime } from '../library/format';
import { reviewKeys, useAdminInterview } from './queries';
import { ReviseScoreForm } from './ReviseScoreForm';
import { BandLabel, FlagBadge, InterviewStateBadge } from './shared';

type Notice = { tone: 'success' | 'warning'; text: string };

function Summary({ interview }: { interview: AdminInterviewDetail }) {
  const { t, i18n } = useTranslation();
  const canSeeCampaigns = useCan('campaigns.read');
  const date = (value: string | null) => (value ? formatDateTime(value, i18n.language) : '—');
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby="interview-summary-heading"
    >
      <h2 id="interview-summary-heading" className="h6">
        {t('review.detail.summary')}
      </h2>
      <dl className="row small mb-0">
        <dt className="col-sm-4 col-lg-3">{t('review.list.candidate')}</dt>
        <dd className="col-sm-8 col-lg-9">
          {interview.candidate.email ?? '—'}
          <div className="font-monospace cb-text-secondary">{interview.candidate.userId}</div>
        </dd>
        <dt className="col-sm-4 col-lg-3">{t('review.list.campaign')}</dt>
        <dd className="col-sm-8 col-lg-9">
          {interview.campaign === null ? (
            t('review.detail.noCampaign')
          ) : canSeeCampaigns ? (
            <Link to={`/campaigns/${interview.campaign.id}`}>{interview.campaign.name}</Link>
          ) : (
            interview.campaign.name
          )}
        </dd>
        <dt className="col-sm-4 col-lg-3">{t('review.detail.mode')}</dt>
        <dd className="col-sm-8 col-lg-9">{t(`library.modes.${interview.mode}`)}</dd>
        <dt className="col-sm-4 col-lg-3">{t('review.list.started')}</dt>
        <dd className="col-sm-8 col-lg-9">{date(interview.startedAt)}</dd>
        <dt className="col-sm-4 col-lg-3">{t('review.detail.ended')}</dt>
        <dd className="col-sm-8 col-lg-9">{date(interview.endedAt)}</dd>
        <dt className="col-sm-4 col-lg-3">{t('campaigns.results.overall')}</dt>
        <dd className="col-sm-8 col-lg-9">
          {interview.overall ?? '—'} · <BandLabel band={interview.band} />
          {interview.scoreRevision !== null && (
            <span className="cb-text-secondary">
              {' '}
              ({t('review.detail.revisionN', { n: interview.scoreRevision })})
            </span>
          )}
        </dd>
        <dt className="col-sm-4 col-lg-3">{t('review.detail.aiCost')}</dt>
        <dd className="col-sm-8 col-lg-9 mb-0">
          {formatMicros(interview.aiCostMicros, 'USD', i18n.language)}
        </dd>
      </dl>
    </section>
  );
}

function FlagSection({
  interview,
  onNotice,
}: {
  interview: AdminInterviewDetail;
  onNotice: (notice: Notice) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const canReview = useCan('interviews.review');
  const canRerun = useCan('interviews.manage');
  const [open, setOpen] = useState<'flag' | 'rerun' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { flag } = interview;

  const setFlag = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<AdminInterviewRow>(`/admin/interviews/${interview.id}/flag`, {
        flagged: !flag.flagged,
        reason,
      }),
    onSuccess: async (row) => {
      setOpen(null);
      setError(null);
      queryClient.setQueryData<AdminInterviewDetail>(
        reviewKeys.interview(interview.id),
        (current) => (current ? { ...current, flag: row.flag } : current),
      );
      await queryClient.invalidateQueries({ queryKey: reviewKeys.interviews });
      onNotice({
        tone: 'success',
        text: row.flag.flagged ? t('review.flag.flaggedDone') : t('review.flag.unflaggedDone'),
      });
    },
    onError: (err) => setError(campaignError(t, err)),
  });

  const rerun = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post(`/admin/interviews/${interview.id}/reprocess`, { reason }),
    onSuccess: () => {
      setOpen(null);
      setError(null);
      onNotice({ tone: 'success', text: t('review.rerun.done') });
    },
    onError: (err) => setError(campaignError(t, err)),
  });

  const canRerunNow = canRerun && interview.state === 'PROCESSING';
  if (!canReview && !canRerunNow && !flag.flagged) return null;

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('review.flag.title')}
      </h2>
      {flag.flagged ? (
        <p className="small">
          <FlagBadge flag={flag} />{' '}
          {t('review.flag.flaggedBy', {
            by: flag.by ?? '—',
            at: flag.at ? formatDateTime(flag.at, i18n.language) : '—',
          })}
          {flag.reason && (
            <span className="d-block cb-text-secondary">
              {t('review.flag.reason', { reason: flag.reason })}
            </span>
          )}
        </p>
      ) : (
        <p className="small cb-text-secondary">{t('review.flag.notFlagged')}</p>
      )}
      {open === null && (
        <div className="d-flex flex-wrap gap-2">
          {canReview && (
            <button
              type="button"
              className={`btn btn-sm ${flag.flagged ? 'btn-outline-secondary' : 'btn-outline-danger'}`}
              onClick={() => {
                setError(null);
                setOpen('flag');
              }}
            >
              {flag.flagged ? t('review.flag.unflag') : t('review.flag.flag')}
            </button>
          )}
          {canRerunNow && (
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              onClick={() => {
                setError(null);
                setOpen('rerun');
              }}
            >
              {t('review.rerun.button')}
            </button>
          )}
        </div>
      )}
      {open === 'flag' && (
        <ReasonForm
          submitLabel={flag.flagged ? t('review.flag.confirmUnflag') : t('review.flag.confirmFlag')}
          danger={!flag.flagged}
          pending={setFlag.isPending}
          error={error}
          onSubmit={(reason) => setFlag.mutate(reason)}
          onCancel={() => setOpen(null)}
        />
      )}
      {open === 'rerun' && (
        <ReasonForm
          submitLabel={t('review.rerun.confirm')}
          pending={rerun.isPending}
          error={error}
          onSubmit={(reason) => rerun.mutate(reason)}
          onCancel={() => setOpen(null)}
        >
          <p className="small">{t('review.rerun.explain')}</p>
        </ReasonForm>
      )}
    </section>
  );
}

function RevisionDimensions({ revision }: { revision: ScoreRevisionSummary }) {
  const { t } = useTranslation();
  return (
    <div className="table-responsive">
      <table className="table table-sm small mb-2">
        <thead>
          <tr>
            <th scope="col">{t('review.revise.dimension')}</th>
            <th scope="col" className="text-end">
              {t('review.scores.weight')}
            </th>
            <th scope="col" className="text-end">
              {t('review.scores.score')}
            </th>
            <th scope="col">{t('review.revise.note')}</th>
          </tr>
        </thead>
        <tbody>
          {revision.dimensions.map((d) => (
            <tr key={d.key}>
              <th scope="row" className="fw-normal">
                {d.name}
              </th>
              <td className="text-end">{d.weight}</td>
              <td className="text-end">{d.score ?? '—'}</td>
              <td>{d.note ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Scores({
  interview,
  onNotice,
}: {
  interview: AdminInterviewDetail;
  onNotice: (notice: Notice) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const canReview = useCan('interviews.review');
  const [revising, setRevising] = useState(false);
  const revisions = [...interview.scoreRevisions].sort((a, b) => b.revision - a.revision);
  const latest = revisions[0];
  const reviewable = interview.state === 'REPORT_READY' && latest !== undefined;

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('review.scores.title')}
      </h2>
      <p className="small cb-text-secondary">{t('review.scores.hint')}</p>
      {revisions.length === 0 && (
        <p className="small cb-text-secondary mb-0">{t('review.scores.none')}</p>
      )}
      {revisions.map((rev) => (
        <details key={rev.revision} className="mb-2" open={rev === latest}>
          <summary className="small">
            <span className="fw-semibold">
              {rev.revision === 0
                ? t('review.scores.original')
                : t('review.detail.revisionN', { n: rev.revision })}
            </span>
            {' · '}
            {t('review.scores.overallLine', { overall: rev.overall ?? '—' })}{' '}
            <BandLabel band={rev.band} />
            {' · '}
            {t('review.scores.byLine', {
              by: rev.createdBy,
              at: formatDateTime(rev.createdAt, i18n.language),
            })}
          </summary>
          {rev.reason && (
            <p className="small mb-1 mt-1">
              {t('review.scores.reasonLine', { reason: rev.reason })}
            </p>
          )}
          <RevisionDimensions revision={rev} />
        </details>
      ))}
      {canReview && !revising && (
        <>
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            disabled={!reviewable}
            aria-describedby={reviewable ? undefined : `${id}-not-reviewable`}
            onClick={() => setRevising(true)}
          >
            {t('review.revise.button')}
          </button>
          {!reviewable && (
            <p id={`${id}-not-reviewable`} className="small cb-text-secondary mt-2 mb-0">
              {t('review.revise.notReviewable')}
            </p>
          )}
        </>
      )}
      {canReview && revising && latest && (
        <ReviseScoreForm
          interview={interview}
          latest={latest}
          onDone={(created) => {
            setRevising(false);
            if (created) {
              onNotice({
                tone: 'success',
                text: t('review.revise.done', { n: created.revision }),
              });
            }
          }}
        />
      )}
    </section>
  );
}

function Reports({ interview }: { interview: AdminInterviewDetail }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('review.reports.title')}
      </h2>
      {interview.reportRevisions.length === 0 ? (
        <p className="small cb-text-secondary mb-0">{t('review.reports.none')}</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm small mb-0">
            <thead>
              <tr>
                <th scope="col">{t('review.reports.revision')}</th>
                <th scope="col">{t('review.reports.scoreRevision')}</th>
                <th scope="col">{t('review.reports.visible')}</th>
                <th scope="col">{t('review.reports.pdf')}</th>
                <th scope="col">{t('review.reports.generated')}</th>
              </tr>
            </thead>
            <tbody>
              {interview.reportRevisions.map((r) => (
                <tr key={r.revision}>
                  <th scope="row" className="fw-normal">
                    {r.revision}
                  </th>
                  <td>{r.scoreRevision}</td>
                  <td>{r.candidateVisible ? t('library.yes') : t('library.no')}</td>
                  <td>{t(`review.reports.pdfStatus.${r.pdfStatus}`)}</td>
                  <td>{formatDateTime(r.generatedAt, i18n.language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Transcript({ interview }: { interview: AdminInterviewDetail }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('review.transcript.title')}
      </h2>
      {interview.turns.length === 0 ? (
        <p className="small cb-text-secondary mb-0">{t('review.transcript.none')}</p>
      ) : (
        <ol className="list-unstyled small mb-0" aria-label={t('review.transcript.title')}>
          {interview.turns.map((turn) => (
            <li key={turn.seq} className="mb-3">
              <div className="cb-text-secondary">
                {t('review.transcript.turnMeta', {
                  seq: turn.seq,
                  round: t(`library.roundTypes.${turn.roundType}`, {
                    defaultValue: turn.roundType,
                  }),
                })}
                {turn.coding && (
                  <span className="badge text-bg-light border ms-2">
                    {t('review.transcript.coding')}
                  </span>
                )}
                {turn.answerSource === 'VOICE' && (
                  <span className="badge text-bg-light border ms-2">
                    {t('review.transcript.voice')}
                  </span>
                )}
              </div>
              <p className="fw-semibold mb-1" style={{ whiteSpace: 'pre-wrap' }}>
                {turn.question}
              </p>
              <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                {turn.answer ?? (
                  <span className="cb-text-secondary">{t('review.transcript.noAnswer')}</span>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Evidence({ interview }: { interview: AdminInterviewDetail }) {
  const { t } = useTranslation();
  const id = useId();
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('review.evidence.title')}
      </h2>
      {interview.evidence.length === 0 ? (
        <p className="small cb-text-secondary mb-0">{t('review.evidence.none')}</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm small mb-0">
            <thead>
              <tr>
                <th scope="col">{t('review.evidence.competency')}</th>
                <th scope="col">{t('review.evidence.claim')}</th>
                <th scope="col" className="text-end">
                  {t('review.evidence.strength')}
                </th>
                <th scope="col" className="text-end">
                  {t('review.evidence.confidence')}
                </th>
                <th scope="col">{t('review.evidence.practical')}</th>
              </tr>
            </thead>
            <tbody>
              {interview.evidence.map((e) => (
                <tr key={e.id}>
                  <th scope="row" className="fw-normal">
                    <code>{e.competencyKey}</code>
                  </th>
                  <td>
                    {e.claim}
                    {e.uncertainty && (
                      <div className="cb-text-secondary">
                        {t('review.evidence.uncertainty', { note: e.uncertainty })}
                      </div>
                    )}
                  </td>
                  <td className="text-end">{e.strength > 0 ? `+${e.strength}` : e.strength}</td>
                  <td className="text-end">{percent(e.confidence)}</td>
                  <td>{e.practical ? t('library.yes') : t('library.no')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function InterviewDetailPage() {
  const { t } = useTranslation();
  const { interviewId = '' } = useParams();
  const interview = useAdminInterview(interviewId);
  const [notice, setNotice] = useState<Notice | null>(null);

  return (
    <>
      <p className="mb-2">
        <Link to="/interviews" className="small">
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          {t('review.detail.back')}
        </Link>
      </p>
      <h1 className="h3 mb-1">{interview.data?.title ?? t('review.detail.title')}</h1>
      <p className="cb-text-secondary small">
        <span className="font-monospace">{interviewId}</span>
        {interview.data && (
          <>
            <span className="ms-2">
              <InterviewStateBadge state={interview.data.state} />
            </span>
            <span className="ms-2">
              <FlagBadge flag={interview.data.flag} />
            </span>
          </>
        )}
      </p>
      <p className="small cb-text-secondary">
        <i className="bi bi-eye me-1" aria-hidden="true" />
        {t('review.detail.audited')}
      </p>
      <div role="status" aria-live="polite">
        {notice && <div className={`alert alert-${notice.tone} py-2`}>{notice.text}</div>}
      </div>
      {interview.isPending && <LoadingRow />}
      {interview.isError && <ErrorAlert error={campaignError(t, interview.error)} />}
      {interview.data && (
        <>
          <Summary interview={interview.data} />
          <FlagSection interview={interview.data} onNotice={setNotice} />
          <Scores interview={interview.data} onNotice={setNotice} />
          <Reports interview={interview.data} />
          <Transcript interview={interview.data} />
          <Evidence interview={interview.data} />
        </>
      )}
    </>
  );
}
