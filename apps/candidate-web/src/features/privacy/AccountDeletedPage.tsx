import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { formatDate } from '../interviews/messages';

/** Shown after a deletion request: when erasure happens and how to cancel it. */
export function AccountDeletedPage() {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const location = useLocation();
  const { manager } = useCandidateAuth();
  const endSession = (location.state as { endSession?: boolean } | null)?.endSession === true;

  // Arriving straight from the deletion request: the server ended every session already.
  useEffect(() => {
    if (endSession) manager.endLocally();
  }, [endSession, manager]);
  const until = params.get('until');
  const valid = until && !Number.isNaN(Date.parse(until));

  return (
    <div className="container py-5">
      <div className="row justify-content-center">
        <div className="col-md-8 col-lg-6">
          <h1 className="h3">{t('privacy.deletedTitle')}</h1>
          <p>
            {valid
              ? t('privacy.deletedBody', { date: formatDate(i18n.resolvedLanguage, until) })
              : t('privacy.deletedBodyNoDate')}
          </p>
          <p className="cb-text-secondary">{t('privacy.deletedCancelHint')}</p>
          <Link to="/" className="btn btn-outline-primary">
            {t('notFound.home')}
          </Link>
        </div>
      </div>
    </div>
  );
}
