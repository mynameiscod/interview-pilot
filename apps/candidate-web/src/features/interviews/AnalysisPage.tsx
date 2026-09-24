import type { InterviewSummary, RoleAnalysis } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { useTrackOnce } from '../../lib/use-analytics';
import { CampaignBanner } from '../campaigns/CampaignBanner';
import { queryKeys, useInterview, useInterviewsApi } from './interviews-api';
import { formatMinutes, inputErrorMessage } from './messages';

const STAGES = ['reading', 'identifying', 'planning'] as const;
const STAGE_MS = 6_000;

function confidenceLevel(confidence: number) {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

/** Progress while the worker analyses the role. Stages advance on a timer (the API has no finer signal). */
function AnalysisProgress() {
  const { t } = useTranslation();
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStage((s) => Math.min(STAGES.length - 1, s + 1)), STAGE_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="progress-title">
      <h2 id="progress-title" className="h5">
        {t('analysis.progress.title')}
      </h2>
      <p className="visually-hidden" role="status" aria-live="polite">
        {t(`analysis.progress.${STAGES[stage]}`)}
      </p>
      <ol className="list-unstyled mb-3">
        {STAGES.map((key, index) => {
          const state = index < stage ? 'done' : index === stage ? 'current' : 'todo';
          return (
            <li key={key} className="d-flex align-items-center gap-2 mb-2">
              {state === 'done' && (
                <i className="bi bi-check-circle-fill text-success" aria-hidden="true" />
              )}
              {state === 'current' && (
                <span
                  className="spinner-border spinner-border-sm text-primary"
                  aria-hidden="true"
                />
              )}
              {state === 'todo' && (
                <i className="bi bi-circle cb-text-secondary" aria-hidden="true" />
              )}
              <span className={state === 'current' ? 'fw-semibold' : undefined}>
                {t(`analysis.progress.${key}`)}
              </span>
              <span className="small cb-text-secondary">
                ({t(`analysis.progress.state.${state}`)})
              </span>
            </li>
          );
        })}
      </ol>
      <p className="small cb-text-secondary mb-0">{t('analysis.progress.note')}</p>
    </section>
  );
}

function SkillList({ skills }: { skills: RoleAnalysis['skills'] }) {
  const { t } = useTranslation();
  const sorted = [...skills].sort((a, b) => b.weight - a.weight);
  return (
    <ul className="list-unstyled mb-0">
      {sorted.map((skill) => (
        <li key={skill.name} className="mb-3">
          <div className="d-flex flex-wrap justify-content-between gap-2">
            <span className="fw-semibold">{skill.name}</span>
            <span className="small">{t('analysis.skills.weight', { weight: skill.weight })}</span>
          </div>
          <div className="progress my-1" style={{ height: '0.5rem' }} aria-hidden="true">
            <div className="progress-bar" style={{ width: `${Math.min(100, skill.weight)}%` }} />
          </div>
          <div className="d-flex flex-wrap gap-1 align-items-center small">
            <span className="visually-hidden">{t('analysis.skills.sources')}:</span>
            {skill.sources.map((source) => (
              <span key={source} className="badge text-bg-light border cb-border fw-normal">
                {t(`analysis.sources.${source}`)}
              </span>
            ))}
            <span className="cb-text-secondary ms-1">
              <i
                className={`bi ${skill.inResume ? 'bi-file-earmark-check' : 'bi-file-earmark'} me-1`}
                aria-hidden="true"
              />
              {skill.inResume ? t('analysis.skills.inResume') : t('analysis.skills.notInResume')}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AnalysisResult({
  interview,
  analysis,
}: {
  interview: InterviewSummary;
  analysis: RoleAnalysis;
}) {
  const { t } = useTranslation();
  const level = confidenceLevel(analysis.detectedRole.confidence);
  const used = (['jd', 'resume', 'companyPatterns'] as const).filter((k) => analysis.inputs[k]);

  return (
    <div className="d-flex flex-column gap-4">
      <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="role-title">
        <p className="small cb-text-secondary mb-1">{t('analysis.detectedRole')}</p>
        <h2 id="role-title" className="h4 mb-2">
          {analysis.detectedRole.title}
        </h2>
        <ul className="list-inline mb-2">
          <li className="list-inline-item badge text-bg-light border cb-border fw-normal">
            {t('analysis.seniorityLabel')}:{' '}
            {t(`analysis.seniority.${analysis.detectedRole.seniority}`)}
          </li>
          <li className="list-inline-item badge text-bg-light border cb-border fw-normal">
            {t(`analysis.confidence.${level}`)}
          </li>
          <li className="list-inline-item badge text-bg-light border cb-border fw-normal">
            {analysis.blueprint.origin === 'CANONICAL'
              ? t('analysis.origin.CANONICAL')
              : t('analysis.origin.AI_GENERATED')}
          </li>
        </ul>
        {interview.companyName && (
          <p className="mb-1">{t('analysis.company', { name: interview.companyName })}</p>
        )}
        {analysis.matchedRole && (
          <p className="mb-1">{t('analysis.matchedRole', { title: analysis.matchedRole.title })}</p>
        )}
        <p className="small cb-text-secondary mb-0">
          {t('analysis.basedOn', {
            inputs:
              used.map((k) => t(`analysis.inputs.${k}`)).join(', ') ||
              t('analysis.inputs.roleOnly'),
          })}
        </p>
      </section>

      <div className="row g-4">
        <section className="col-lg-6" aria-labelledby="skills-title">
          <div className="p-4 border cb-border rounded-3 bg-white h-100">
            <h2 id="skills-title" className="h5">
              {t('analysis.skills.title')}
            </h2>
            <p className="small cb-text-secondary">{t('analysis.skills.hint')}</p>
            <SkillList skills={analysis.skills} />
          </div>
        </section>

        <section className="col-lg-6" aria-labelledby="rounds-title">
          <div className="p-4 border cb-border rounded-3 bg-white h-100">
            <h2 id="rounds-title" className="h5">
              {t('analysis.rounds.title')}
            </h2>
            <p className="small cb-text-secondary">
              {t('analysis.rounds.total', {
                duration: formatMinutes(t, analysis.totalDurationSec),
              })}
            </p>
            <ol className="list-group list-group-numbered">
              {analysis.plannedRounds.map((round, index) => (
                <li key={`${round.type}-${index}`} className="list-group-item">
                  <span className="fw-semibold">{t(`analysis.roundTypes.${round.type}`)}</span>
                  <span className="cb-text-secondary">
                    {' '}
                    · {formatMinutes(t, round.durationSec)}
                  </span>
                  {round.focus.length > 0 && (
                    <div className="small cb-text-secondary">
                      {t('analysis.rounds.focus', { topics: round.focus.join(', ') })}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>

      <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="resume-title">
        <h2 id="resume-title" className="h5">
          {t('analysis.resume.title')}
        </h2>
        {analysis.inputs.resume ? (
          <div className="row g-4">
            <div className="col-md-6">
              <h3 className="h6">
                <i className="bi bi-star me-2 text-secondary" aria-hidden="true" />
                {t('analysis.resume.highlights')}
              </h3>
              {analysis.resumeHighlights.length ? (
                <ul className="mb-0">
                  {analysis.resumeHighlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              ) : (
                <p className="small cb-text-secondary mb-0">{t('analysis.resume.none')}</p>
              )}
            </div>
            <div className="col-md-6">
              <h3 className="h6">
                <i className="bi bi-search me-2 text-secondary" aria-hidden="true" />
                {t('analysis.resume.gaps')}
              </h3>
              {analysis.gaps.length ? (
                <ul className="mb-0">
                  {analysis.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              ) : (
                <p className="small cb-text-secondary mb-0">{t('analysis.resume.none')}</p>
              )}
            </div>
          </div>
        ) : (
          <p className="cb-text-secondary mb-0">{t('analysis.resume.notProvided')}</p>
        )}
      </section>
    </div>
  );
}

export function AnalysisPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useInterviewsApi();
  const queryClient = useQueryClient();
  const interview = useInterview(id);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useTrackOnce('analysis_viewed', Boolean(interview.data?.analysis));

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
  const editLink = `/app/new?edit=${encodeURIComponent(data.id)}`;

  async function analyze() {
    setRetrying(true);
    setError(null);
    try {
      queryClient.setQueryData(queryKeys.interview(data.id), await api.analyze(data.id));
      void queryClient.invalidateQueries({ queryKey: queryKeys.interviews, exact: true });
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setRetrying(false);
    }
  }

  let body: ReactNode;
  if (data.state === 'ROLE_ANALYSIS') {
    body = <AnalysisProgress />;
  } else if (data.state === 'DRAFT' || data.state === 'FAILED') {
    const code = data.failure?.code;
    body = (
      <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="failed-title">
        <h2 id="failed-title" className="h5">
          <i
            className={`bi ${code ? 'bi-exclamation-octagon text-danger' : 'bi-hourglass'} me-2`}
            aria-hidden="true"
          />
          {code ? t('analysis.failed.title') : t('analysis.draft.title')}
        </h2>
        <p>{code ? t(`analysis.failed.${code}`) : t('analysis.draft.body')}</p>
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}
        <div className="d-flex flex-wrap gap-2">
          {code !== 'INPUT_FAILED' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={retrying}
              onClick={() => void analyze()}
            >
              {code ? t('analysis.retry') : t('analysis.draft.start')}
            </button>
          )}
          {!data.campaign && (
            <Link to={editLink} className="btn btn-outline-primary">
              {t('analysis.editInputs')}
            </Link>
          )}
        </div>
      </section>
    );
  } else if (data.state === 'CANCELLED' || !data.analysis) {
    body = (
      <section className="p-4 border cb-border rounded-3 bg-white">
        <p className="mb-3">
          {t('interview.stateNotice', { state: t(`interview.states.${data.state}`) })}
        </p>
        <Link to="/app" className="btn btn-outline-primary">
          {t('interview.backToDashboard')}
        </Link>
      </section>
    );
  } else {
    body = (
      <>
        <AnalysisResult interview={data} analysis={data.analysis} />
        {data.state === 'READY' && (
          <div className="d-flex flex-wrap gap-2 mt-4">
            <Link to={`/app/interviews/${data.id}/setup`} className="btn btn-primary btn-lg">
              {t('analysis.looksRight')}
            </Link>
            {!data.campaign && (
              <Link to={editLink} className="btn btn-outline-primary btn-lg">
                {t('analysis.editInputs')}
              </Link>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="container py-5">
      <h1 className="h3">{t('analysis.title')}</h1>
      <p className="cb-text-secondary">{data.title}</p>
      <CampaignBanner campaign={data.campaign} />
      {body}
    </div>
  );
}
