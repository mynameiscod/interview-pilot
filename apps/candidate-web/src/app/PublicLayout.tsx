import { BrandLogo } from '@cbi/design-system';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useCandidateAuth } from './session';

function AccountNav() {
  const { t } = useTranslation();
  const { status, signOut } = useCandidateAuth();
  const navigate = useNavigate();

  if (status === 'loading') return null;
  if (status === 'signedOut') {
    return (
      <div className="d-flex align-items-center gap-1 gap-sm-2">
        <NavLink to="/pricing" className="btn btn-link btn-sm">
          {t('nav.pricing')}
        </NavLink>
        <Link to="/login" className="btn btn-primary btn-sm">
          {t('nav.signIn')}
        </Link>
      </div>
    );
  }
  return (
    <div className="d-flex align-items-center gap-1 gap-sm-2">
      <NavLink to="/app" end className="btn btn-link btn-sm">
        {t('nav.dashboard')}
      </NavLink>
      <NavLink to="/app/history" className="btn btn-link btn-sm">
        {t('nav.history')}
      </NavLink>
      <NavLink to="/app/purchases" className="btn btn-link btn-sm">
        {t('nav.purchases')}
      </NavLink>
      <NavLink to="/pricing" className="btn btn-link btn-sm">
        {t('nav.buyCredits')}
      </NavLink>
      <NavLink to="/app/profile" className="btn btn-link btn-sm">
        {t('nav.profile')}
      </NavLink>
      <button
        type="button"
        className="btn btn-outline-secondary btn-sm"
        onClick={async () => {
          await signOut().catch(() => undefined);
          // Guards on protected pages also send an explicitly signed-out user home.
          await navigate('/', { replace: true });
        }}
      >
        {t('nav.signOut')}
      </button>
    </div>
  );
}

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
          <div className="d-flex flex-wrap align-items-center gap-2">
            <AccountNav />
            <LanguageSwitcher />
          </div>
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
