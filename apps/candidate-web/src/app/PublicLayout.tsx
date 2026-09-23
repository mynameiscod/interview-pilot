import { BrandLogo } from '@cbi/design-system';
import { useTranslation } from 'react-i18next';
import { Link, Outlet } from 'react-router';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

export function PublicLayout() {
  const { t } = useTranslation();
  return (
    <>
      <a href="#main" className="cb-skip-link">
        {t('a11y.skipToContent')}
      </a>
      <header className="border-bottom cb-border bg-white">
        <nav
          className="container d-flex flex-wrap align-items-center justify-content-between gap-2 py-2"
          aria-label={t('a11y.primaryNavigation')}
        >
          <Link
            to="/"
            className="d-flex align-items-center gap-2 text-decoration-none"
            aria-label={t('app.homeLink')}
          >
            <BrandLogo asset="codebegunLogo" />
            <span className="d-flex flex-column lh-sm">
              <span className="fw-semibold text-primary">{t('app.productName')}</span>
              <span className="small cb-text-secondary">{t('app.endorsement')}</span>
            </span>
          </Link>
          <LanguageSwitcher />
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="border-top cb-border py-4 mt-5">
        <div className="container small cb-text-secondary">
          {t('footer.copyright', { year: new Date().getFullYear() })}
        </div>
      </footer>
    </>
  );
}
