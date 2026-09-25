import type { InterviewSummary } from '@cbi/shared-types';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useInterviews } from './interviews-api';
import { formatDate, interviewPath, isLive, reportVisible } from './messages';

const STATE_ICON: Partial<Record<string, string>> = {
  ROLE_ANALYSIS: 'bi-hourglass-split',
  READY: 'bi-check-circle',
  FAILED: 'bi-exclamation-octagon',
  CANCELLED: 'bi-x-circle',
  READY_TO_START: 'bi-play-circle',
  ACTIVE: 'bi-broadcast',
  ROUND_TRANSITION: 'bi-broadcast',
  RECONNECTING: 'bi-arrow-repeat',
  PAUSED: 'bi-pause-circle',
  COMPLETING: 'bi-hourglass-split',
  PROCESSING: 'bi-hourglass-split',
  REPORT_READY: 'bi-file-earmark-check',
  EXPIRED: 'bi-hourglass-bottom',
};

/** Finished interviews whose results went to the company (the report may be hidden). */
const SUBMITTED_STATES = new Set(['COMPLETING', 'PROCESSING', 'REPORT_READY']);

/** The action label (and its accessible name) for an interview's link. */
function linkLabels(t: TFunction, interview: InterviewSummary) {
  if (isLive(interview.state)) {
    return {
      label: t('dashboard.resume'),
      name: t('dashboard.resumeNamed', { title: interview.title }),
    };
  }
  if (interview.state === 'REPORT_READY' && reportVisible(interview)) {
    return {
      label: t('dashboard.viewReport'),
      name: t('dashboard.viewReportNamed', { title: interview.title }),
    };
  }
  const name = t('dashboard.openNamed', { title: interview.title });
  if (interview.state === 'READY') return { label: t('dashboard.continue'), name };
  if (interview.state === 'READY_TO_START') return { label: t('dashboard.start'), name };
  return { label: t('dashboard.view'), name };
}

/** Mode icons for the row tile. */
const MODE_ICON: Record<InterviewSummary['mode'], string> = {
  TEXT: 'bi-chat-left-text',
  VOICE: 'bi-mic',
  VIDEO: 'bi-camera-video',
};

/** Pill colour for a state: finished, live, problem, or neutral. */
function pillClass(state: InterviewSummary['state']) {
  if (state === 'REPORT_READY') return 'cb-pill--success';
  if (isLive(state)) return 'cb-pill--active';
  if (state === 'FAILED' || state === 'EXPIRED') return 'cb-pill--danger';
  return '';
}

/** The dashboard shows the latest few; History has the rest. */
const RECENT_LIMIT = 5;

/** Dashboard list of the candidate's latest interviews with a link to continue each. */
export function RecentInterviews() {
  const { t, i18n } = useTranslation();
  const interviews = useInterviews();

  return (
    <section className="cb-dash-card" aria-labelledby="recent-title">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
        <h2 id="recent-title" className="h5 mb-0 d-flex align-items-center gap-2">
          <i className="bi bi-clock-history text-secondary" aria-hidden="true" />
          {t('dashboard.recentTitle')}
        </h2>
        <Link to="/app/history" className="link-secondary text-decoration-none small fw-semibold">
          {t('dashboard.recentAll')}
          <i className="bi bi-arrow-right ms-1" aria-hidden="true" />
        </Link>
      </div>
      {interviews.isPending && <p className="cb-text-secondary mb-0">{t('common.loading')}</p>}
      {interviews.isError && (
        <p className="cb-text-secondary mb-0" role="alert">
          {t('dashboard.recentError')}
        </p>
      )}
      {interviews.data?.length === 0 && (
        <p className="cb-text-secondary mb-0">{t('dashboard.recentEmpty')}</p>
      )}
      {interviews.data && interviews.data.length > 0 && (
        <ul className="list-unstyled mb-0">
          {interviews.data.slice(0, RECENT_LIMIT).map((interview) => {
            const minutes = Math.round(
              (interview.analysis?.totalDurationSec ?? interview.template.totalDurationSec) / 60,
            );
            return (
              <li
                key={interview.id}
                className="cb-dash-row d-flex flex-wrap align-items-center gap-3 py-3"
              >
                <span className="cb-icon-tile cb-icon-tile--primary">
                  <i className={`bi ${MODE_ICON[interview.mode]}`} aria-hidden="true" />
                </span>
                <div className="flex-grow-1" style={{ minWidth: '10rem' }}>
                  <div className="fw-semibold text-break">{interview.title}</div>
                  <div className="small cb-text-secondary">
                    {[
                      interview.companyName,
                      formatDate(i18n.resolvedLanguage, interview.createdAt),
                      minutes > 0 ? t('dashboard.minutes', { count: minutes }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {interview.campaign && (
                    <div className="small">
                      <i className="bi bi-building me-1 text-secondary" aria-hidden="true" />
                      {t('campaign.banner.invitedBy', { company: interview.campaign.companyName })}
                      {interview.campaign.sponsored && (
                        <span className="badge text-bg-success fw-normal ms-2">
                          {t('campaign.sponsoredBadge')}
                        </span>
                      )}
                    </div>
                  )}
                  {!reportVisible(interview) && SUBMITTED_STATES.has(interview.state) && (
                    <div className="small cb-text-secondary">
                      {t('campaign.submitted', { company: interview.campaign?.companyName ?? '' })}
                    </div>
                  )}
                </div>
                <span className={`cb-pill ${pillClass(interview.state)}`}>
                  <i
                    className={`bi ${STATE_ICON[interview.state] ?? 'bi-circle'}`}
                    aria-hidden="true"
                  />
                  {t(`interview.states.${interview.state}`)}
                </span>
                {interview.state !== 'CANCELLED' && (
                  <Link
                    to={interviewPath(interview)}
                    className={`btn btn-sm px-3 ${isLive(interview.state) ? 'btn-primary' : 'btn-outline-primary'}`}
                    aria-label={linkLabels(t, interview).name}
                  >
                    {linkLabels(t, interview).label}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
