import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDate } from '../interviews/messages';
import { useConsentHistory } from './consent-api';

/** Privacy: every consent decision, newest first, with the notice version it applied to. */
export function ConsentHistory() {
  const { t, i18n } = useTranslation();
  const history = useConsentHistory();
  const entries = [...(history.data ?? [])].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="consents-title">
      <h2 id="consents-title" className="h5">
        {t('privacy.consentsTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('privacy.consentsHint')}</p>
      {history.isPending && <p className="small mb-0">{t('common.loading')}</p>}
      {history.isError && <p className="small mb-0">{t('privacy.consentsError')}</p>}
      {history.data && entries.length === 0 && (
        <p className="small mb-0">{t('privacy.consentsEmpty')}</p>
      )}
      {entries.length > 0 && (
        <ul className="list-group">
          {entries.map((entry) => (
            <li key={entry.id} className="list-group-item">
              <div className="d-flex flex-wrap justify-content-between gap-2">
                <span className="fw-semibold">{entry.title}</span>
                <span className="small">
                  <i
                    className={`bi ${entry.accepted ? 'bi-check-circle' : 'bi-dash-circle'} me-1`}
                    aria-hidden="true"
                  />
                  {entry.accepted ? t('privacy.accepted') : t('privacy.declined')}
                </span>
              </div>
              <div className="small cb-text-secondary">
                {t('privacy.entryMeta', {
                  date: formatDate(i18n.resolvedLanguage, entry.at),
                  version: entry.version,
                })}
                {entry.sessionId && (
                  <>
                    {' · '}
                    <Link to={`/app/reports/${entry.sessionId}`}>{t('privacy.interview')}</Link>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
