import {
  AVAILABLE_INTERVIEW_MODES,
  InterviewLanguagePreference,
  InterviewMode,
  type InterviewSummary,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { queryKeys, useInterview, useInterviewsApi } from './interviews-api';
import { formatMinutes, inputErrorMessage } from './messages';

const MODE_ICON = { TEXT: 'bi-keyboard', VOICE: 'bi-mic', VIDEO: 'bi-camera-video' } as const;

const isModeSelectable = (interview: InterviewSummary, mode: InterviewMode) =>
  AVAILABLE_INTERVIEW_MODES.includes(mode) && interview.template.modes.includes(mode);

function SetupForm({ interview }: { interview: InterviewSummary }) {
  const { t } = useTranslation();
  const id = useId();
  const api = useInterviewsApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<InterviewMode>(interview.mode);
  const [language, setLanguage] = useState(interview.language);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const duration = interview.analysis?.totalDurationSec ?? interview.template.totalDurationSec;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateSetup(interview.id, { mode, language });
      queryClient.setQueryData(queryKeys.interview(interview.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.interviews, exact: true });
      setSaved(true);
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setSaving(false);
    }
  }

  async function cancelInterview() {
    setCancelling(true);
    setError(null);
    try {
      const updated = await api.cancel(interview.id);
      queryClient.setQueryData(queryKeys.interview(interview.id), updated);
      await queryClient.invalidateQueries({ queryKey: queryKeys.interviews, exact: true });
      await navigate('/app', { replace: true });
    } catch (err) {
      setError(inputErrorMessage(t, err));
      setCancelling(false);
      setConfirmCancel(false);
    }
  }

  if (saved) {
    return (
      <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="ready-title">
        <div role="status">
          <h2 id="ready-title" className="h4">
            <i className="bi bi-check-circle text-success me-2" aria-hidden="true" />
            {t('setup.ready.title')}
          </h2>
          <p>{t('setup.ready.body')}</p>
        </div>
        <dl className="row mb-3">
          <dt className="col-sm-4">{t('setup.modeTitle')}</dt>
          <dd className="col-sm-8">{t(`setup.modes.${mode}.name`)}</dd>
          <dt className="col-sm-4">{t('setup.languageTitle')}</dt>
          <dd className="col-sm-8">{t(`profileForm.languages.${language}`)}</dd>
          <dt className="col-sm-4">{t('setup.durationTitle')}</dt>
          <dd className="col-sm-8">{formatMinutes(t, duration)}</dd>
        </dl>
        <div className="d-flex flex-wrap gap-2">
          <Link to="/app" className="btn btn-primary">
            {t('interview.backToDashboard')}
          </Link>
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={() => setSaved(false)}
          >
            {t('setup.ready.change')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="p-4 border cb-border rounded-3 bg-white d-flex flex-column gap-4">
        <fieldset>
          <legend className="h5">{t('setup.modeTitle')}</legend>
          <div className="row g-3">
            {InterviewMode.options.map((option) => {
              const selectable = isModeSelectable(interview, option);
              const inputId = `${id}-mode-${option}`;
              return (
                <div key={option} className="col-md-4">
                  <div
                    className={`h-100 p-3 rounded-3 border ${
                      mode === option ? 'border-primary' : 'cb-border'
                    } ${selectable ? '' : 'cb-surface-muted'}`}
                  >
                    <div className="form-check">
                      <input
                        id={inputId}
                        type="radio"
                        name={`${id}-mode`}
                        className="form-check-input"
                        value={option}
                        checked={mode === option}
                        disabled={!selectable}
                        aria-describedby={`${inputId}-desc`}
                        onChange={() => setMode(option)}
                      />
                      <label htmlFor={inputId} className="form-check-label fw-semibold">
                        <i className={`bi ${MODE_ICON[option]} me-2`} aria-hidden="true" />
                        {t(`setup.modes.${option}.name`)}
                      </label>
                    </div>
                    <p id={`${inputId}-desc`} className="small cb-text-secondary mb-0 mt-1">
                      {selectable ? t(`setup.modes.${option}.body`) : t('setup.comingSoon')}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>

        <fieldset aria-describedby={`${id}-lang-hint`}>
          <legend className="h5">{t('setup.languageTitle')}</legend>
          <p id={`${id}-lang-hint`} className="small cb-text-secondary">
            {t('setup.languageHint')}
          </p>
          <div className="d-flex flex-wrap gap-3">
            {InterviewLanguagePreference.options.map((lng) => (
              <div key={lng} className="form-check">
                <input
                  id={`${id}-lang-${lng}`}
                  type="radio"
                  name={`${id}-lang`}
                  className="form-check-input"
                  checked={language === lng}
                  onChange={() => setLanguage(lng)}
                />
                <label htmlFor={`${id}-lang-${lng}`} className="form-check-label">
                  {t(`profileForm.languages.${lng}`)}
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        <section aria-labelledby={`${id}-summary`}>
          <h2 id={`${id}-summary`} className="h5">
            {t('setup.summaryTitle')}
          </h2>
          <dl className="row mb-0">
            <dt className="col-sm-4">{t('setup.durationTitle')}</dt>
            <dd className="col-sm-8">{formatMinutes(t, duration)}</dd>
            <dt className="col-sm-4">{t('setup.costTitle')}</dt>
            <dd className="col-sm-8">
              {t('setup.credits', { count: interview.template.creditCost })}
              <div className="small cb-text-secondary">{t('setup.creditsNote')}</div>
            </dd>
          </dl>
        </section>

        {error && (
          <div className="alert alert-danger mb-0" role="alert">
            {error}
          </div>
        )}

        <div className="d-flex flex-wrap gap-2 align-items-center">
          <button type="submit" className="btn btn-primary btn-lg" disabled={saving}>
            {saving ? t('setup.saving') : t('setup.save')}
          </button>
          <Link to={`/app/interviews/${interview.id}/analysis`} className="btn btn-link">
            {t('setup.backToAnalysis')}
          </Link>
        </div>
      </div>

      <section
        className="p-4 border cb-border rounded-3 bg-white mt-4"
        aria-labelledby={`${id}-cancel`}
      >
        <h2 id={`${id}-cancel`} className="h6">
          {t('setup.cancel.title')}
        </h2>
        <p className="small cb-text-secondary">{t('setup.cancel.body')}</p>
        {confirmCancel ? (
          <div className="d-flex flex-wrap gap-2" role="group" aria-label={t('setup.cancel.title')}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={cancelling}
              onClick={() => void cancelInterview()}
            >
              {t('setup.cancel.confirm')}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={() => setConfirmCancel(false)}
            >
              {t('setup.cancel.keep')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-outline-danger"
            onClick={() => setConfirmCancel(true)}
          >
            {t('setup.cancel.action')}
          </button>
        )}
      </section>
    </form>
  );
}

export function SetupPage() {
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
  if (['DRAFT', 'ROLE_ANALYSIS', 'FAILED'].includes(data.state)) {
    return <Navigate to={`/app/interviews/${data.id}/analysis`} replace />;
  }

  return (
    <div className="container py-5">
      <h1 className="h3">{t('setup.title')}</h1>
      <p className="cb-text-secondary">{data.title}</p>
      {data.state === 'READY' ? (
        <SetupForm interview={data} />
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
