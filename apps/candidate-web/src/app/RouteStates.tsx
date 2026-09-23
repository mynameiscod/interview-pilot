import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { NotFoundPage } from '../pages/NotFoundPage';

export function RouteLoading() {
  const { t } = useTranslation();
  return (
    <div className="container py-5 d-flex justify-content-center" role="status">
      <div className="spinner-border text-primary" aria-hidden="true" />
      <span className="visually-hidden">{t('common.loading')}</span>
    </div>
  );
}

export function RouteError() {
  const error = useRouteError();
  const { t } = useTranslation();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  return (
    <div className="container py-5" role="alert">
      <h1 className="h3">{t('error.title')}</h1>
      <p className="cb-text-secondary">{t('error.body')}</p>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        {t('error.reload')}
      </button>
    </div>
  );
}
