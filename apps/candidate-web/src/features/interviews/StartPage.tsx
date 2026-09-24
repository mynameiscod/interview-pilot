import type { InterviewSummary } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { queryKeys, useCreditBalance, useInterview, useInterviewsApi } from './interviews-api';
import {
  formatMinutes,
  inputErrorMessage,
  interviewPath,
  isEnded,
  isLive,
  startErrorMessage,
} from './messages';

function CreditSummary({ interview }: { interview: InterviewSummary }) {
  const { t } = useTranslation();
  const balance = useCreditBalance();
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="start-credit">
      <h2 id="start-credit" className="h5">
        <i className="bi bi-coin me-2 text-secondary" aria-hidden="true" />
        {t('start.creditTitle')}
      </h2>
      <p className="fw-semibold mb-1">
        {t('setup.credits', { count: interview.template.creditCost })}
      </p>
      <p className="mb-2">
        {balance.isPending && t('common.loading')}
        {balance.isError && t('start.balanceError')}
        {balance.data && t('start.balance', { count: balance.data.available })}
        {balance.data?.available === 0 && (
          <>
            {' '}
            <Link to="/pricing">{t('nav.buyCredits')}</Link>
          </>
        )}
      </p>
      <p className="small cb-text-secondary mb-0">{t('start.refundNote')}</p>
    </section>
  );
}

function StartScreen({ interview }: { interview: InterviewSummary }) {
  const { t } = useTranslation();
  const api = useInterviewsApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{
    message: string;
    inProgress: boolean;
    noCredits: boolean;
  } | null>(null);
  const rounds = interview.analysis?.plannedRounds ?? [];

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const started = await api.start(interview.id);
      queryClient.setQueryData(queryKeys.interview(interview.id), started);
      void queryClient.invalidateQueries({ queryKey: queryKeys.interviews, exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.credits });
      await navigate(`/app/interviews/${interview.id}/room`);
    } catch (err) {
      setError({
        message: startErrorMessage(t, err),
        inProgress: err instanceof ApiClientError && err.code === 'CONFLICT',
        noCredits: err instanceof ApiClientError && err.code === 'INSUFFICIENT_CREDITS',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.credits });
      setStarting(false);
    }
  }

  return (
    <div className="d-flex flex-column gap-4">
      <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="start-rules">
        <h2 id="start-rules" className="h5">
          <i className="bi bi-list-check me-2 text-secondary" aria-hidden="true" />
          {t('start.rulesTitle')}
        </h2>
        <ul className="mb-3">
          <li>{t('start.rules.text')}</li>
          <li>
            {t('start.rules.duration', {
              duration: formatMinutes(t, interview.template.totalDurationSec),
            })}
          </li>
          <li>{t('start.rules.ownWords')}</li>
          <li>{t('start.rules.noScores')}</li>
          <li>{t('start.rules.connection')}</li>
        </ul>
        {rounds.length > 0 && (
          <>
            <h3 className="h6">{t('start.roundsTitle')}</h3>
            <ol className="mb-0">
              {rounds.map((round, index) => (
                <li key={`${round.type}-${index}`}>
                  {t(`analysis.roundTypes.${round.type}`)}
                  <span className="cb-text-secondary">
                    {' '}
                    · {formatMinutes(t, round.durationSec)}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <CreditSummary interview={interview} />

      {error && (
        <div className="alert alert-danger mb-0" role="alert">
          <p className="mb-0">{error.message}</p>
          {error.inProgress && (
            <Link to="/app" className="alert-link">
              {t('start.goToDashboard')}
            </Link>
          )}
          {error.noCredits && (
            <Link to="/pricing" className="alert-link">
              {t('start.buyCredits')}
            </Link>
          )}
        </div>
      )}

      <div className="d-flex flex-wrap gap-2 align-items-center">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={starting}
          onClick={() => void start()}
        >
          <i className="bi bi-play-fill me-1" aria-hidden="true" />
          {starting ? t('start.starting') : t('start.action')}
        </button>
        <Link to={`/app/interviews/${interview.id}/setup`} className="btn btn-link">
          {t('start.backToSetup')}
        </Link>
      </div>
    </div>
  );
}

/** Screen 15: rules recap, credit cost and the start button (the credit is reserved here). */
export function StartPage() {
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
  if (isLive(data.state) || isEnded(data)) return <Navigate to={interviewPath(data)} replace />;
  if (
    ['DRAFT', 'ROLE_ANALYSIS'].includes(data.state) ||
    (data.state === 'FAILED' && !data.startedAt)
  ) {
    return <Navigate to={`/app/interviews/${data.id}/analysis`} replace />;
  }

  return (
    <div className="container py-5">
      <h1 className="h3">{t('start.title')}</h1>
      <p className="cb-text-secondary">{data.title}</p>
      {data.state === 'READY' || data.state === 'READY_TO_START' ? (
        <StartScreen interview={data} />
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
