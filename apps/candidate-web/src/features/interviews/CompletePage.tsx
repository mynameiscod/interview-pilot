import type { InterviewSummary } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { useInterview } from './interviews-api';
import { inputErrorMessage, interviewPath, isEnded } from './messages';

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

function CreditOutcome({ interview, outcome }: { interview: InterviewSummary; outcome: Outcome }) {
  const { t } = useTranslation();
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

/** Screens 21–22: thank-you, what happens next and what happened to the credit. */
export function CompletePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const interview = useInterview(id);

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
        <p role="status">{t(`complete.${outcome}.body`)}</p>
        <div className="p-3 rounded-3 cb-surface-muted mb-4">
          <h2 className="h6">{t('complete.creditTitle')}</h2>
          <CreditOutcome interview={data} outcome={outcome} />
        </div>
        <Link to="/app" className="btn btn-primary">
          {t('interview.backToDashboard')}
        </Link>
      </section>
    </div>
  );
}
