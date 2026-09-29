import { UiLocale, type DrillMode } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { queryKeys, useInterviewsApi } from '../interviews/interviews-api';
import { inputErrorMessage, nextStepPath, startErrorMessage } from '../interviews/messages';
import { progressKeys, useCreateDrill, useProgress } from './progress-api';
import { drillPath, weakest } from './progress-format';
import './progress.scss';

/** Minutes a drill takes, about 2 minutes 20 seconds per question. */
const drillMinutes = (questions: number) => Math.max(1, Math.round((questions * 140) / 60));

type Problem = { message: string; limit: boolean; inProgress: boolean };

function drillProblem(t: ReturnType<typeof useTranslation>['t'], err: unknown): Problem {
  const code = err instanceof ApiClientError ? err.code : null;
  if (code === 'DRILL_LIMIT_REACHED') {
    return { message: t('drill.start.errors.limit'), limit: true, inProgress: false };
  }
  if (code === 'CONFLICT') {
    return { message: t('start.errors.inProgress'), limit: false, inProgress: true };
  }
  if (code === 'INVALID_STATE') {
    return { message: t('drill.start.errors.noInterview'), limit: false, inProgress: false };
  }
  return { message: startErrorMessage(t, err), limit: false, inProgress: false };
}

/**
 * Starts a practice drill on one skill: the questions, the time and the free
 * drills left today, then text or voice. A text drill goes straight into the
 * room; voice goes through the device check and consents first.
 */
export function DrillStartPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [params] = useSearchParams();
  const key = params.get('dimension') ?? '';
  const progress = useProgress();
  const create = useCreateDrill();
  const interviewsApi = useInterviewsApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<DrillMode>('TEXT');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  if (progress.isPending) return <RouteLoading />;
  if (progress.isError || !progress.data) {
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{t('drill.start.loadError')}</h1>
        <p className="cb-text-secondary">{inputErrorMessage(t, progress.error)}</p>
        <Link to="/app" className="btn btn-outline-primary">
          {t('interview.backToDashboard')}
        </Link>
      </div>
    );
  }

  const data = progress.data;
  const dimension = data.dimensions.find((d) => d.key === key && d.current);
  if (!dimension) {
    const options = weakest(data.dimensions);
    return (
      <div className="container py-5" style={{ maxWidth: '40rem' }}>
        <h1 className="h3">{t('drill.start.chooseTitle')}</h1>
        {options.length === 0 ? (
          <>
            <p className="cb-text-secondary">{t('drill.start.errors.noInterview')}</p>
            <Link to="/app/new" className="btn btn-primary">
              {t('dashboard.startCta')}
            </Link>
          </>
        ) : (
          <ul className="list-unstyled d-flex flex-column gap-2">
            {options.map((d) => (
              <li key={d.key}>
                <Link to={drillPath(d.key)} className="btn btn-outline-primary w-100 text-start">
                  {d.name}
                  {d.latest !== null && (
                    <span className="cb-text-secondary"> · {d.latest}/100</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const quota = data.drills;
  const limitReached = quota.freePerDay > 0 && quota.remainingToday === 0;
  const off = quota.freePerDay === 0;

  async function start() {
    setBusy(true);
    setProblem(null);
    try {
      const drill = await create.mutateAsync({ dimensionKey: key, mode });
      queryClient.setQueryData(queryKeys.interview(drill.id), drill);
      const next = nextStepPath(drill);
      if (!next.endsWith('/start')) {
        await navigate(next);
        return;
      }
      // Nothing to check first: start at once and go into the room.
      const uiLocale = UiLocale.safeParse(i18n.resolvedLanguage);
      const started = await interviewsApi.start(
        drill.id,
        uiLocale.success ? { uiLocale: uiLocale.data } : {},
      );
      queryClient.setQueryData(queryKeys.interview(drill.id), started);
      void queryClient.invalidateQueries({ queryKey: progressKeys.overview });
      await navigate(`/app/interviews/${drill.id}/room`);
    } catch (err) {
      setProblem(drillProblem(t, err));
      void queryClient.invalidateQueries({ queryKey: progressKeys.overview });
      setBusy(false);
    }
  }

  return (
    <div className="container py-5" style={{ maxWidth: '44rem' }}>
      <p className="small cb-text-secondary mb-1">{t('drill.eyebrow')}</p>
      <h1 className="h3 mb-3">{t('drill.start.title', { name: dimension.name })}</h1>
      <section
        className="p-4 border cb-border rounded-3 bg-white mb-4"
        aria-labelledby={`${id}-what`}
      >
        <h2 id={`${id}-what`} className="h5">
          {t('drill.start.whatTitle')}
        </h2>
        <ul className="mb-0">
          <li>
            {t('drill.start.questions', {
              count: quota.questions,
              minutes: drillMinutes(quota.questions),
            })}
          </li>
          <li>{t('drill.start.feedback')}</li>
          <li>
            {dimension.latest === null
              ? t('drill.start.firstScore')
              : t('drill.start.lastScore', { score: dimension.latest })}
          </li>
          <li>
            {off
              ? t('progress.hero.drillsOff')
              : t('drill.start.free', { left: quota.remainingToday, total: quota.freePerDay })}
          </li>
        </ul>
      </section>

      <fieldset className="mb-4">
        <legend className="h5">{t('drill.start.modeTitle')}</legend>
        {(['TEXT', 'VOICE'] as const).map((m) => (
          <div key={m} className="form-check mb-2">
            <input
              id={`${id}-${m}`}
              className="form-check-input"
              type="radio"
              name={`${id}-mode`}
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            <label className="form-check-label" htmlFor={`${id}-${m}`}>
              <span className="fw-semibold d-block">{t(`setup.modes.${m}.name`)}</span>
              <span className="small cb-text-secondary">{t(`drill.start.modes.${m}`)}</span>
            </label>
          </div>
        ))}
      </fieldset>

      {(problem || limitReached) && (
        <div className="alert alert-warning" role="alert">
          <p className="mb-1">{problem?.message ?? t('drill.start.errors.limit')}</p>
          {(problem?.limit || limitReached) && (
            <p className="mb-0">
              {t('drill.start.upgrade')}{' '}
              <Link to="/app/new" className="alert-link">
                {t('dashboard.startCta')}
              </Link>{' '}
              ·{' '}
              <Link to="/pricing" className="alert-link">
                {t('nav.buyCredits')}
              </Link>
            </p>
          )}
          {problem?.inProgress && (
            <Link to="/app" className="alert-link">
              {t('start.goToDashboard')}
            </Link>
          )}
        </div>
      )}

      <div className="d-flex flex-wrap gap-2 align-items-center">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={busy || limitReached || off}
          onClick={() => void start()}
        >
          <i className="bi bi-lightning-charge me-1" aria-hidden="true" />
          {busy ? t('drill.start.starting') : t('drill.start.action')}
        </button>
        <Link to="/app" className="btn btn-link">
          {t('interview.backToDashboard')}
        </Link>
      </div>
    </div>
  );
}
