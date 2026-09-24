import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { useInterview } from '../interviews/interviews-api';
import { inputErrorMessage, interviewPath, isEnded, isLive } from '../interviews/messages';
import { ConsentStep } from './ConsentStep';

const PRE_START = ['READY', 'DEVICE_CHECK', 'CONSENT_REQUIRED', 'READY_TO_START'];

/** The consent step on its own (text interviews with session observations, or a later change). */
export function ConsentPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
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
  if (isLive(data.state) || isEnded(data)) return <Navigate to={interviewPath(data)} replace />;
  if (['DRAFT', 'ROLE_ANALYSIS', 'FAILED'].includes(data.state)) {
    return <Navigate to={`/app/interviews/${data.id}/analysis`} replace />;
  }

  return (
    <div className="container py-5" style={{ maxWidth: '48rem' }}>
      <h1 className="h3">{t('consent.pageTitle')}</h1>
      <p className="cb-text-secondary">{data.title}</p>
      {PRE_START.includes(data.state) ? (
        <>
          <ConsentStep
            sessionId={data.id}
            onDone={() => void navigate(`/app/interviews/${data.id}/start`)}
          />
          <Link to={`/app/interviews/${data.id}/setup`} className="btn btn-link px-0 mt-3">
            {t('start.backToSetup')}
          </Link>
        </>
      ) : (
        <section className="p-4 border cb-border rounded-3 bg-white">
          <p className="mb-3">
            {t('interview.stateNotice', { state: t(`interview.states.${data.state}`) })}
          </p>
          <Link to="/app" className="btn btn-outline-primary">
            {t('interview.backToDashboard')}
          </Link>
        </section>
      )}
    </div>
  );
}
