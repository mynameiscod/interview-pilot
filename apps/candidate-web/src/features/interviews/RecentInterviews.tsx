import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useInterviews } from './interviews-api';
import { formatDate, interviewPath } from './messages';

const STATE_ICON: Partial<Record<string, string>> = {
  ROLE_ANALYSIS: 'bi-hourglass-split',
  READY: 'bi-check-circle',
  FAILED: 'bi-exclamation-octagon',
  CANCELLED: 'bi-x-circle',
};

/** Dashboard list of the candidate's latest interviews with a link to continue each. */
export function RecentInterviews() {
  const { t, i18n } = useTranslation();
  const interviews = useInterviews();

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="recent-title">
      <h2 id="recent-title" className="h5">
        {t('dashboard.recentTitle')}
      </h2>
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
        <ul className="list-group list-group-flush">
          {interviews.data.map((interview) => (
            <li
              key={interview.id}
              className="list-group-item px-0 d-flex flex-wrap align-items-center gap-2"
            >
              <div className="flex-grow-1">
                <div className="fw-semibold text-break">{interview.title}</div>
                <div className="small cb-text-secondary">
                  {[interview.companyName, formatDate(i18n.resolvedLanguage, interview.createdAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <span className="badge text-bg-light border cb-border fw-normal">
                <i
                  className={`bi ${STATE_ICON[interview.state] ?? 'bi-circle'} me-1`}
                  aria-hidden="true"
                />
                {t(`interview.states.${interview.state}`)}
              </span>
              {interview.state !== 'CANCELLED' && (
                <Link
                  to={interviewPath(interview)}
                  className="btn btn-sm btn-outline-primary"
                  aria-label={t('dashboard.openNamed', { title: interview.title })}
                >
                  {interview.state === 'READY' ? t('dashboard.continue') : t('dashboard.view')}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
