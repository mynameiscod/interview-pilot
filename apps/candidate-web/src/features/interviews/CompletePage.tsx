import type { InterviewSummary, ProcessingProgress, ProcessingStage } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { CampaignBanner } from '../campaigns/CampaignBanner';
import { FEEDBACK_ANCHOR, useProcessingProgress } from '../reports/reports-api';
import { queryKeys, useInterview } from './interviews-api';
import { inputErrorMessage, interviewPath, isEnded, reportVisible } from './messages';

type Outcome = 'processing' | 'expired' | 'failed';

function outcomeOf(interview: InterviewSummary): Outcome {
  if (interview.state === 'EXPIRED') return 'expired';
  if (interview.state === 'FAILED') return 'failed';
  return 'processing';
}

const OUTCOME_ICON: Record<Outcome, string> = {
  processing: 'bi-check-circle text-success',
  expired: 'bi-hourglass-bottom text-secondary',
  failed: 'bi-exclamation-octagon text-danger',
};

/** Pipeline stages grouped into the steps a candidate sees. */
const STEPS: { key: string; stages: ProcessingStage[] }[] = [
  { key: 'reviewing', stages: ['FINALIZE_TRANSCRIPT', 'EXTRACT_EVIDENCE'] },
  { key: 'scoring', stages: ['SCORE_DIMENSIONS', 'AGGREGATE'] },
  { key: 'planning', stages: ['RECOMMENDATIONS'] },
  { key: 'preparing', stages: ['BUILD_REPORT'] },
];

function CreditOutcome({ interview, outcome }: { interview: InterviewSummary; outcome: Outcome }) {
  const { t } = useTranslation();
  if (interview.credit === 'SPONSORED') {
    return (
      <p className="mb-0">
        {interview.campaign
          ? t('complete.credit.SPONSORED', { company: interview.campaign.companyName })
          : t('complete.credit.sponsoredGeneric')}
      </p>
    );
  }
  if (interview.credit === 'CONSUMED') {
    return (
      <p className="mb-0">
        {t('complete.credit.CONSUMED', { count: interview.template.creditCost })}
      </p>
    );
  }
  if (interview.credit === 'REFUNDED') {
    return (
      <p className="mb-0">
        {outcome === 'processing'
          ? t('complete.credit.REFUNDED')
          : t('complete.credit.refundedGeneric')}
      </p>
    );
  }
  if (interview.credit === 'RESERVED') {
    return <p className="mb-0 cb-text-secondary">{t('complete.credit.RESERVED')}</p>;
  }
  return <p className="mb-0">{t('complete.credit.NONE')}</p>;
}

/** Screen 22: where evaluation has got to, as a short checklist. */
function StageChecklist({ progress }: { progress: ProcessingProgress | undefined }) {
  const { t } = useTranslation();
  const completed = new Set(progress?.completedStages ?? []);
  const ready = Boolean(progress?.reportReady);
  const failed = progress?.status === 'FAILED';
  const doneFlags = STEPS.map((step) => ready || step.stages.every((s) => completed.has(s)));
  const current = doneFlags.indexOf(false);

  return (
    <div className="mb-4">
      <h2 className="h6">{t('complete.progress.title')}</h2>
      <p className="visually-hidden" role="status" aria-live="polite">
        {ready
          ? t('complete.progress.ready')
          : current >= 0
            ? t(`complete.progress.${STEPS[current]!.key}`)
            : ''}
      </p>
      <ol className="list-unstyled mb-0">
        {STEPS.map((step, index) => {
          const state = doneFlags[index]
            ? 'done'
            : index === current
              ? failed
                ? 'stuck'
                : 'current'
              : 'todo';
          return (
            <li key={step.key} className="d-flex align-items-center gap-2 mb-2">
              {state === 'done' && (
                <i className="bi bi-check-circle-fill text-success" aria-hidden="true" />
              )}
              {state === 'current' && (
                <span
                  className="spinner-border spinner-border-sm text-primary"
                  aria-hidden="true"
                />
              )}
              {state === 'stuck' && (
                <i className="bi bi-hourglass-split text-warning" aria-hidden="true" />
              )}
              {state === 'todo' && (
                <i className="bi bi-circle cb-text-secondary" aria-hidden="true" />
              )}
              <span className={state === 'current' ? 'fw-semibold' : undefined}>
                {t(`complete.progress.${step.key}`)}
              </span>
              <span className="small cb-text-secondary">
                ({t(`complete.progress.state.${state}`)})
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Screens 21–22: thank-you, evaluation progress and what happened to the credit. */
export function CompletePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const interview = useInterview(id);
  const state = interview.data?.state;
  // A campaign may keep the report from the candidate: then nothing about it is loaded or linked.
  const canSeeReport = interview.data ? reportVisible(interview.data) : false;
  const evaluating = canSeeReport && (state === 'PROCESSING' || state === 'COMPLETING');
  const progress = useProcessingProgress(id, evaluating);
  const reportReady =
    canSeeReport && (state === 'REPORT_READY' || Boolean(progress.data?.reportReady));

  // Once the report exists the interview (and its credit) has moved on too.
  useEffect(() => {
    if (progress.data?.reportReady) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.interview(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.interviews });
    }
  }, [progress.data?.reportReady, queryClient, id]);

  if (interview.isPending) return <RouteLoading />;
  if (interview.isError || !interview.data) {
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{t('analysis.loadErrorTitle')}</h1>
        <p className="cb-text-secondary">{inputErrorMessage(t, interview.error)}</p>
        <Link to="/app" className="btn btn-outline-primary">
          {t('interview.backToDashboard')}
        </Link>
      </div>
    );
  }
  const data = interview.data;
  if (!isEnded(data)) return <Navigate to={interviewPath(data)} replace />;
  const outcome = outcomeOf(data);
  const stalled = progress.data?.status === 'FAILED' && !reportReady;
  const reportPath = `/app/reports/${data.id}`;

  return (
    <div className="container py-5">
      <section
        className="p-4 border cb-border rounded-3 bg-white mx-auto"
        style={{ maxWidth: '44rem' }}
        aria-labelledby="complete-title"
      >
        <h1 id="complete-title" className="h3">
          <i className={`bi ${OUTCOME_ICON[outcome]} me-2`} aria-hidden="true" />
          {t(`complete.${outcome}.title`)}
        </h1>
        <p className="cb-text-secondary">{data.title}</p>
        <CampaignBanner campaign={data.campaign} />
        {outcome === 'processing' && !canSeeReport ? (
          <p role="status">
            {t('campaign.submitted', { company: data.campaign?.companyName ?? '' })}
          </p>
        ) : outcome === 'processing' ? (
          <>
            <p role="status">
              {reportReady ? t('complete.reportReady') : t('complete.processing.body')}
            </p>
            {!reportReady && <StageChecklist progress={progress.data} />}
            {stalled && (
              <div className="alert alert-warning" role="alert">
                {t('complete.stalled')}
              </div>
            )}
          </>
        ) : (
          <p role="status">{t(`complete.${outcome}.body`)}</p>
        )}
        <div className="p-3 rounded-3 cb-surface-muted mb-4">
          <h2 className="h6">{t('complete.creditTitle')}</h2>
          <CreditOutcome interview={data} outcome={outcome} />
        </div>
        <div className="d-flex flex-wrap gap-2">
          {reportReady && (
            <>
              <Link to={reportPath} className="btn btn-primary">
                {t('complete.viewReport')}
              </Link>
              <Link
                to={{ pathname: reportPath, hash: FEEDBACK_ANCHOR }}
                className="btn btn-outline-primary"
              >
                {t('complete.rateInterview')}
              </Link>
            </>
          )}
          <Link to="/app" className={`btn ${reportReady ? 'btn-link' : 'btn-primary'}`}>
            {t('interview.backToDashboard')}
          </Link>
        </div>
      </section>
    </div>
  );
}
