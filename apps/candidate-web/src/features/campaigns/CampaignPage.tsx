import type { PublicCampaign } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useTrackOnce } from '../../lib/use-analytics';
import { RouteLoading } from '../../app/RouteStates';
import { useCandidateAuth } from '../../app/session';
import { queryKeys, useInterview, useResumes } from '../interviews/interviews-api';
import { formatMinutes, inputErrorMessage, interviewPath } from '../interviews/messages';
import { usePublicCampaign, useCampaignsApi } from './campaigns-api';

function formatDateTime(lng: string | undefined, iso: string): string {
  try {
    return new Intl.DateTimeFormat(lng, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  } catch {
    return new Date(iso).toString();
  }
}

/** Why the campaign cannot be joined, in the candidate's language. */
function closedMessage(t: TFunction, lng: string | undefined, campaign: PublicCampaign): string {
  const { window } = campaign;
  switch (campaign.closedReason) {
    case 'NOT_STARTED':
      return t('campaign.closed.NOT_STARTED', { date: formatDateTime(lng, window.startAt) });
    case 'ENDED':
      return window.endAt
        ? t('campaign.closed.ENDED', { date: formatDateTime(lng, window.endAt) })
        : t('campaign.closed.CLOSED');
    case 'PAUSED':
      return t('campaign.closed.PAUSED', { company: campaign.companyName });
    case 'FULL':
      return t('campaign.closed.FULL');
    default:
      return t('campaign.closed.CLOSED');
  }
}

/** An existing campaign interview: links to wherever it is best continued. */
function ContinueLink({ interviewId }: { interviewId: string }) {
  const { t } = useTranslation();
  const interview = useInterview(interviewId);
  const to = interview.data
    ? interviewPath(interview.data)
    : `/app/interviews/${encodeURIComponent(interviewId)}/analysis`;
  return (
    <Link to={to} className="btn btn-primary btn-lg">
      {t('campaign.continue')}
    </Link>
  );
}

/** Lets a signed-in candidate attach one of their resumes (optional). */
function ResumePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const resumes = useResumes();
  const ready = (resumes.data ?? []).filter((r) => r.extraction.status === 'READY');
  if (ready.length === 0) return null;
  return (
    <div className="mb-3">
      <label htmlFor={id} className="form-label fw-semibold">
        {t('campaign.join.resumeLabel')}
      </label>
      <select
        id={id}
        className="form-select"
        aria-describedby={`${id}-hint`}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{t('campaign.join.noResume')}</option>
        {ready.map((resume) => (
          <option key={resume.id} value={resume.id}>
            {resume.originalName ?? resume.id}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="small cb-text-secondary mt-1 mb-0">
        {t('campaign.join.resumeHint')}
      </p>
    </div>
  );
}

function JoinSection({ token, campaign }: { token: string; campaign: PublicCampaign }) {
  const { t, i18n } = useTranslation();
  const { status } = useCandidateAuth();
  const api = useCampaignsApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setJoining(true);
    setError(null);
    try {
      const result = await api.join(token, resumeId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.interviews, exact: true });
      await navigate(`/app/interviews/${encodeURIComponent(result.interviewId)}/analysis`);
    } catch (err) {
      setError(inputErrorMessage(t, err));
      if (err instanceof ApiClientError && err.code === 'CAMPAIGN_CLOSED') {
        // The campaign closed since the page loaded: show why.
        await queryClient.invalidateQueries({ queryKey: ['campaigns', token] });
      }
      setJoining(false);
    }
  }

  if (campaign.joinedInterviewId) {
    return (
      <div className="d-flex flex-column gap-3 align-items-start">
        {campaign.closedReason && (
          <div className="alert alert-warning mb-0 w-100" role="status">
            {closedMessage(t, i18n.resolvedLanguage, campaign)}
          </div>
        )}
        <p className="mb-0">{t('campaign.alreadyJoined')}</p>
        <ContinueLink interviewId={campaign.joinedInterviewId} />
      </div>
    );
  }

  if (campaign.closedReason) {
    return (
      <>
        {error && (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        )}
        <div className="alert alert-warning mb-0" role="status">
          <i className="bi bi-door-closed me-2" aria-hidden="true" />
          {closedMessage(t, i18n.resolvedLanguage, campaign)}
        </div>
      </>
    );
  }

  if (status !== 'signedIn') {
    const next = encodeURIComponent(`/campaign/${token}`);
    return (
      <div className="d-flex flex-column gap-2 align-items-start">
        <p className="mb-0">{t('campaign.join.signInFirst')}</p>
        <Link to={`/login?next=${next}`} className="btn btn-primary btn-lg">
          {t('campaign.join.action')}
        </Link>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void join();
      }}
    >
      <ResumePicker value={resumeId} onChange={setResumeId} />
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <button type="submit" className="btn btn-primary btn-lg" disabled={joining}>
        {joining ? t('campaign.join.joining') : t('campaign.join.action')}
      </button>
    </form>
  );
}

function Details({ campaign }: { campaign: PublicCampaign }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.resolvedLanguage;
  return (
    <dl className="row mb-0">
      <dt className="col-sm-4">{t('campaign.details.role')}</dt>
      <dd className="col-sm-8">{campaign.roleTitle}</dd>
      {campaign.assesses.length > 0 && (
        <>
          <dt className="col-sm-4">{t('campaign.details.assesses')}</dt>
          <dd className="col-sm-8">
            <ul className="list-inline mb-0">
              {campaign.assesses.map((name) => (
                <li
                  key={name}
                  className="list-inline-item badge text-bg-light border cb-border fw-normal"
                >
                  {name}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
      <dt className="col-sm-4">{t('campaign.details.duration')}</dt>
      <dd className="col-sm-8">{formatMinutes(t, campaign.totalDurationSec)}</dd>
      <dt className="col-sm-4">{t('campaign.details.modes')}</dt>
      <dd className="col-sm-8">
        {campaign.modes.map((m) => t(`setup.modes.${m}.name`)).join(', ')}
      </dd>
      <dt className="col-sm-4">{t('campaign.details.languages')}</dt>
      <dd className="col-sm-8">
        {campaign.languages.map((l) => t(`profileForm.languages.${l}`)).join(', ')}
      </dd>
      <dt className="col-sm-4">{t('campaign.details.window')}</dt>
      <dd className="col-sm-8">
        {campaign.window.endAt
          ? t('campaign.details.windowRange', {
              start: formatDateTime(lng, campaign.window.startAt),
              end: formatDateTime(lng, campaign.window.endAt),
            })
          : t('campaign.details.windowFrom', {
              start: formatDateTime(lng, campaign.window.startAt),
            })}
      </dd>
    </dl>
  );
}

function Notices({ campaign }: { campaign: PublicCampaign }) {
  const { t } = useTranslation();
  const company = campaign.companyName;
  return (
    <ul className="list-unstyled mb-0 d-flex flex-column gap-2">
      <li>
        <i
          className={`bi ${campaign.sponsored ? 'bi-gift' : 'bi-coin'} me-2 text-secondary`}
          aria-hidden="true"
        />
        {campaign.sponsored ? t('campaign.sponsoredNote') : t('campaign.notices.ownCredits')}
      </li>
      <li>
        <i className="bi bi-share me-2 text-secondary" aria-hidden="true" />
        {t('campaign.notices.sharing', { company })}
      </li>
      <li>
        <i
          className={`bi ${campaign.candidateSeesReport ? 'bi-file-earmark-check' : 'bi-file-earmark-lock'} me-2 text-secondary`}
          aria-hidden="true"
        />
        {campaign.candidateSeesReport
          ? t('campaign.notices.reportVisible')
          : t('campaign.notices.reportHidden', { company })}
      </li>
      <li>
        <i
          className={`bi ${campaign.recording === 'OFF' ? 'bi-camera-video-off' : 'bi-record-circle'} me-2 text-secondary`}
          aria-hidden="true"
        />
        {t(`campaign.notices.recording.${campaign.recording}`)}
      </li>
      {campaign.observations && (
        <li>
          <i className="bi bi-eye me-2 text-secondary" aria-hidden="true" />
          {t('campaign.notices.observations')}
        </li>
      )}
    </ul>
  );
}

/** Public invite landing page (`/campaign/:token`): what the interview is, and joining it. */
export function CampaignPage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const campaign = usePublicCampaign(token);
  useTrackOnce('campaign_landing_viewed', Boolean(campaign.data));

  if (campaign.isPending) return <RouteLoading />;
  if (campaign.isError || !campaign.data) {
    const notFound = campaign.error instanceof ApiClientError && campaign.error.status === 404;
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{notFound ? t('campaign.notFound.title') : t('campaign.loadError')}</h1>
        <p className="cb-text-secondary">
          {notFound ? t('campaign.notFound.body') : inputErrorMessage(t, campaign.error)}
        </p>
        <Link to="/" className="btn btn-outline-primary">
          {t('notFound.home')}
        </Link>
      </div>
    );
  }
  const data = campaign.data;

  return (
    <div className="container py-5">
      <div className="mx-auto" style={{ maxWidth: '48rem' }}>
        <p className="small text-uppercase fw-semibold cb-text-secondary mb-1">
          {t('campaign.invitedBy', { company: data.companyName })}
        </p>
        <h1 className="h3">{data.name}</h1>
        <p className="lead">
          {t('campaign.intro', { company: data.companyName, role: data.roleTitle })}
        </p>
        {data.sponsored && (
          <p className="d-inline-block badge text-bg-success fw-normal fs-6 mb-3">
            {t('campaign.sponsoredFree', { company: data.companyName })}
          </p>
        )}

        <section
          className="p-4 border cb-border rounded-3 bg-white mb-4"
          aria-labelledby="campaign-details"
        >
          <h2 id="campaign-details" className="h5">
            {t('campaign.details.title')}
          </h2>
          <Details campaign={data} />
        </section>

        <section
          className="p-4 border cb-border rounded-3 bg-white mb-4"
          aria-labelledby="campaign-notices"
        >
          <h2 id="campaign-notices" className="h5">
            {t('campaign.notices.title')}
          </h2>
          <Notices campaign={data} />
        </section>

        <section
          className="p-4 border cb-border rounded-3 bg-white"
          aria-labelledby="campaign-join"
        >
          <h2 id="campaign-join" className="h5">
            {t('campaign.join.title')}
          </h2>
          <JoinSection token={token} campaign={data} />
        </section>
      </div>
    </div>
  );
}
