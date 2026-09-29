import type { DrillResult } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { formatDate, inputErrorMessage, isLive } from '../interviews/messages';
import { progressKeys, useDrillResult } from './progress-api';
import { drillPath, signed } from './progress-format';
import './progress.scss';

function ScoreSummary({ result }: { result: DrillResult }) {
  const { t, i18n } = useTranslation();
  const change =
    result.score !== null && result.previousScore !== null
      ? result.score - result.previousScore
      : null;
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="drill-score">
      <h2 id="drill-score" className="h5">
        {t('drill.result.scoreTitle')}
      </h2>
      {result.score === null ? (
        <p className="mb-0">{t('drill.result.noScore')}</p>
      ) : (
        <div className="d-flex flex-wrap align-items-end gap-3">
          <p className="mb-0">
            <span className="cb-drill-score">{result.score}</span>
            <span className="cb-text-secondary"> / 100</span>
          </p>
          <p className="mb-1">
            {result.previousScore === null
              ? t('drill.result.firstScore')
              : t('drill.result.previous', {
                  score: result.previousScore,
                  change: signed(change!),
                })}
          </p>
        </div>
      )}
      {result.confidence && (
        <p className="small cb-text-secondary mt-2 mb-0">
          {t('drill.result.confidence', {
            level: t(`report.confidence.${result.confidence}`),
          })}
          {result.completedAt && ` · ${formatDate(i18n.resolvedLanguage, result.completedAt)}`}
        </p>
      )}
      {result.rationale && <p className="mt-3 mb-0">{result.rationale}</p>}
    </section>
  );
}

function QuestionFeedback({ result }: { result: DrillResult }) {
  const { t } = useTranslation();
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="drill-questions">
      <h2 id="drill-questions" className="h5">
        {t('drill.result.questionsTitle')}
      </h2>
      <ol className="ps-3 mb-0">
        {result.questions.map((q) => (
          <li key={q.seq} className="mb-3">
            <p className="fw-semibold mb-1">{q.question}</p>
            {!q.answered && (
              <p className="small cb-text-secondary mb-1">{t('drill.result.skipped')}</p>
            )}
            {q.feedback.length === 0 && q.answered && (
              <p className="small cb-text-secondary mb-0">{t('drill.result.noFeedback')}</p>
            )}
            <ul className="list-unstyled d-flex flex-column gap-1 mb-0">
              {q.feedback.map((f, i) => (
                <li
                  key={i}
                  className={`cb-feedback-item small ${f.strength > 0 ? 'cb-feedback-item--positive' : f.strength < 0 ? 'cb-feedback-item--negative' : ''}`}
                >
                  <span className="visually-hidden">
                    {f.strength > 0
                      ? t('drill.result.strength')
                      : f.strength < 0
                        ? t('drill.result.toImprove')
                        : t('drill.result.neutral')}
                    :{' '}
                  </span>
                  {f.claim}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A drill's quick evaluation: its score, the change since last time and feedback per question. */
export function DrillResultPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const result = useDrillResult(id);
  const queryClient = useQueryClient();
  const ready = result.data?.state === 'REPORT_READY';

  // The hub's trends, streak and badges change once the drill is scored.
  useEffect(() => {
    if (ready) void queryClient.invalidateQueries({ queryKey: progressKeys.overview });
  }, [ready, queryClient]);

  if (result.isPending) return <RouteLoading />;
  if (result.isError || !result.data) {
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{t('drill.result.loadError')}</h1>
        <p className="cb-text-secondary">{inputErrorMessage(t, result.error)}</p>
        <Link to="/app" className="btn btn-outline-primary">
          {t('interview.backToDashboard')}
        </Link>
      </div>
    );
  }

  const data = result.data;
  const evaluating = ['COMPLETING', 'PROCESSING'].includes(data.state);
  return (
    <div className="container py-5" style={{ maxWidth: '48rem' }}>
      <p className="small cb-text-secondary mb-1">{t('drill.eyebrow')}</p>
      <h1 className="h3 mb-4">{t('drill.result.title', { name: data.dimension.name })}</h1>
      <div className="d-flex flex-column gap-4">
        {isLive(data.state) && (
          <div className="alert alert-info mb-0">
            {t('drill.result.inProgress')}{' '}
            <Link to={`/app/interviews/${data.sessionId}/room`} className="alert-link">
              {t('dashboard.resume')}
            </Link>
          </div>
        )}
        {evaluating && (
          <div className="alert alert-info mb-0" role="status">
            <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
            {t('drill.result.evaluating')}
          </div>
        )}
        {ready && <ScoreSummary result={data} />}
        {data.questions.length > 0 && <QuestionFeedback result={data} />}
        <div className="d-flex flex-wrap gap-2">
          <Link to={drillPath(data.dimension.key)} className="btn btn-primary">
            <i className="bi bi-arrow-repeat me-1" aria-hidden="true" />
            {t('drill.result.again')}
          </Link>
          <Link to="/app" className="btn btn-outline-primary">
            {t('interview.backToDashboard')}
          </Link>
        </div>
      </div>
    </div>
  );
}
