import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="container py-5">
      <h1 className="h3">{t('notFound.title')}</h1>
      <p className="cb-text-secondary">{t('notFound.body')}</p>
      <Link to="/" className="btn btn-outline-primary">
        {t('notFound.home')}
      </Link>
    </div>
  );
}
