import type { CompareResult } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { formatDate, inputErrorMessage } from '../interviews/messages';
import { CONFIDENCE_ICON, DELTA_ICON, deltaText, scoreText } from './report-format';
import { useCompare } from './reports-api';

function ScoreCell({ score }: { score: number | null }) {
  const { t } = useTranslation();
  return (
    <>
      <span>{scoreText(t, score)}</span>
      <div
        className="progress mt-1"
        style={{ height: '0.35rem', minWidth: '4rem' }}
        aria-hidden="true"
      >
        {score !== null && <div className="progress-bar" style={{ width: `${score}%` }} />}
      </div>
    </>
  );
}

function Problem({ title, body }: { title: string; body: string }) {
  const { t } = useTranslation();
  return (
    <div className="container py-5" role="alert">
      <h1 className="h3">{title}</h1>
      <p className="cb-text-secondary">{body}</p>
      <Link to="/app/history" className="btn btn-outline-primary">
        {t('compare.backToHistory')}
      </Link>
    </div>
  );
}

function CompareTable({ result }: { result: CompareResult }) {
  const { t, i18n } = useTranslation();
  const { attempts } = result;
  const first = attempts[0]?.overall ?? null;
  const last = attempts.at(-1)?.overall ?? null;
  return (
    <div className="table-responsive">
      <table className="table align-middle">
        <caption className="visually-hidden">{t('compare.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('compare.skill')}</th>
            {attempts.map((a, index) => (
              <th key={a.sessionId} scope="col">
                <Link to={`/app/reports/${a.sessionId}`}>
                  {t('compare.attempt', { n: index + 1 })}
                </Link>
                <span className="d-block small fw-normal cb-text-secondary">
                  {a.endedAt ? formatDate(i18n.resolvedLanguage, a.endedAt) : '–'}
                </span>
              </th>
            ))}
            <th scope="col">{t('compare.change')}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="table-light">
            <th scope="row">{t('compare.overall')}</th>
            {attempts.map((a) => (
              <td key={a.sessionId} className="fw-semibold">
                <ScoreCell score={a.overall} />
              </td>
            ))}
            <td>{first !== null && last !== null ? deltaText(t, last - first) : '–'}</td>
          </tr>
          <tr>
            <th scope="row">{t('compare.confidence')}</th>
            {attempts.map((a) => (
              <td key={a.sessionId} className="text-nowrap">
                <i className={`bi ${CONFIDENCE_ICON[a.confidence]} me-1`} aria-hidden="true" />
                {t(`report.confidence.${a.confidence}`)}
              </td>
            ))}
            <td>–</td>
          </tr>
          {result.dimensions.map((d) => (
            <tr key={d.key}>
              <th scope="row" className="fw-normal">
                {d.name}
              </th>
              {d.scores.map((score, index) => (
                <td key={index}>
                  <ScoreCell score={score} />
                </td>
              ))}
              <td className="text-nowrap">
                {d.delta === null ? (
                  t('compare.noDelta')
                ) : (
                  <>
                    <i className={`bi ${DELTA_ICON(d.delta)} me-1`} aria-hidden="true" />
                    {deltaText(t, d.delta)}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Screen 26: 2–4 attempts of the same role side by side, with each skill's change. */
export function ComparePage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const ids = (params.get('sessions') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = ids.length >= 2 && ids.length <= 4;
  const compare = useCompare(ids, valid);

  if (!valid) return <Problem title={t('compare.invalidTitle')} body={t('compare.invalidBody')} />;
  if (compare.isPending) return <RouteLoading />;
  if (compare.isError || !compare.data) {
    const invalid = compare.error instanceof ApiClientError && compare.error.status === 400;
    return (
      <Problem
        title={invalid ? t('compare.invalidTitle') : t('compare.loadError')}
        body={invalid ? t('compare.invalidBody') : inputErrorMessage(t, compare.error)}
      />
    );
  }

  return (
    <div className="container py-5">
      <h1 className="h3">{t('compare.title')}</h1>
      <p className="cb-text-secondary">{t('compare.subtitle')}</p>
      <section className="p-4 border cb-border rounded-3 bg-white">
        <CompareTable result={compare.data} />
        <Link to="/app/history" className="btn btn-outline-primary">
          {t('compare.backToHistory')}
        </Link>
      </section>
    </div>
  );
}
