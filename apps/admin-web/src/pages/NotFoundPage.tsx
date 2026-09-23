import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <>
      <h1 className="h3">{t('notFound.title')}</h1>
      <Link to="/" className="btn btn-outline-primary mt-2">
        {t('notFound.home')}
      </Link>
    </>
  );
}
