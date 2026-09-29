import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useUnsubscribe } from './progress-api';

/**
 * The target of the "stop these emails" link in practice nudges. It asks for
 * a click (link scanners only fetch pages) and needs no sign-in: the signed
 * token in the link identifies the candidate.
 */
export function UnsubscribePage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const unsubscribe = useUnsubscribe();

  return (
    <div className="container py-5" style={{ maxWidth: '36rem' }}>
      <h1 className="h3">{t('unsubscribe.title')}</h1>
      {unsubscribe.isSuccess ? (
        <div role="status">
          <p>{t('unsubscribe.done')}</p>
          <p className="small cb-text-secondary">{t('unsubscribe.profileHint')}</p>
          <Link to="/app/profile" className="btn btn-outline-primary">
            {t('unsubscribe.profile')}
          </Link>
        </div>
      ) : !token ? (
        <p role="alert">{t('unsubscribe.invalid')}</p>
      ) : (
        <>
          <p>{t('unsubscribe.body')}</p>
          {unsubscribe.isError && (
            <div className="alert alert-danger" role="alert">
              {t('unsubscribe.invalid')}
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={unsubscribe.isPending}
            onClick={() => unsubscribe.mutate(token)}
          >
            {unsubscribe.isPending ? t('unsubscribe.working') : t('unsubscribe.action')}
          </button>
        </>
      )}
    </div>
  );
}
