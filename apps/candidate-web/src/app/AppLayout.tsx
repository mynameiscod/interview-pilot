import { BrandLogo } from '@cbi/design-system';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { MaintenanceBanner } from '../components/MaintenanceBanner';
import { RouteAnalytics } from '../lib/use-analytics';
import { useCandidateAuth } from './session';
import './app-shell.scss';

const NAV_ITEMS = [
  { to: '/app', key: 'nav.dashboard', icon: 'bi-house-door' },
  { to: '/app/history', key: 'nav.history', icon: 'bi-clock-history' },
  { to: '/app/purchases', key: 'nav.purchases', icon: 'bi-cart3' },
  { to: '/pricing', key: 'nav.buyCredits', icon: 'bi-database' },
  { to: '/app/profile', key: 'nav.profile', icon: 'bi-person' },
] as const;

/** Avatar button with the candidate's name, a profile link and sign-out. */
function AccountMenu() {
  const { t } = useTranslation();
  const { user, signOut } = useCandidateAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  const name = user.profile.displayName ?? user.email ?? user.mobile ?? '';
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="position-relative" ref={ref}>
      <button
        type="button"
        className="btn btn-link text-decoration-none d-flex align-items-center gap-1 p-1"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="account-menu"
        aria-label={t('nav.accountMenu')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cb-avatar" aria-hidden="true">
          {initial}
        </span>
        <i className="bi bi-chevron-down small cb-text-secondary" aria-hidden="true" />
      </button>
      {open && (
        <div id="account-menu" className="cb-account-menu border cb-border rounded-3 bg-white p-2">
          <div className="px-2 py-1 border-bottom cb-border mb-1">
            <div className="fw-semibold text-break">{name}</div>
            {user.email && user.email !== name && (
              <div className="small cb-text-secondary text-break">{user.email}</div>
            )}
          </div>
          <Link
            to="/app/profile"
            className="btn btn-link btn-sm w-100 text-start text-decoration-none"
            onClick={() => setOpen(false)}
          >
            <i className="bi bi-person me-2" aria-hidden="true" />
            {t('nav.profile')}
          </Link>
          <button
            type="button"
            className="btn btn-link btn-sm w-100 text-start text-decoration-none"
            onClick={async () => {
              setOpen(false);
              await signOut().catch(() => undefined);
              // Guards on protected pages also send an explicitly signed-out user home.
              await navigate('/', { replace: true });
            }}
          >
            <i className="bi bi-box-arrow-right me-2" aria-hidden="true" />
            {t('nav.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Signed-in candidate pages: navy sidebar, a slim top bar and the page content. */
export function AppLayout() {
  const { t } = useTranslation();
  const [navOpen, setNavOpen] = useState(false);
  return (
    <>
      <a href="#main" className="cb-skip-link">
        {t('a11y.skipToContent')}
      </a>
      <div className="cb-app-shell d-lg-flex">
        <aside
          id="app-nav"
          className={`cb-app-sidebar flex-shrink-0 p-3 ${navOpen ? '' : 'd-none'} d-lg-flex flex-column`}
        >
          <Link
            to="/app"
            className="cb-app-brand text-decoration-none"
            aria-label={t('app.homeLink')}
          >
            <BrandLogo asset="codebegunLogoReversed" />
            <span className="d-block fw-semibold mt-2">{t('app.productName')}</span>
            <span className="d-block small cb-app-brand-muted">{t('app.tagline')}</span>
          </Link>
          <nav aria-label={t('a11y.appNavigation')} className="mt-4">
            <ul className="nav flex-column gap-1">
              {NAV_ITEMS.map((item) => (
                <li className="nav-item" key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/app'}
                    className={({ isActive }) => `cb-app-nav-link ${isActive ? 'active' : ''}`}
                    onClick={() => setNavOpen(false)}
                  >
                    <i className={`bi ${item.icon}`} aria-hidden="true" />
                    {t(item.key)}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <div className="flex-grow-1 d-flex flex-column" style={{ minWidth: 0 }}>
          <header className="cb-app-topbar border-bottom cb-border bg-white d-flex align-items-center gap-2 px-3 py-2">
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm d-lg-none"
              aria-controls="app-nav"
              aria-expanded={navOpen}
              aria-label={t('a11y.toggleNavigation')}
              onClick={() => setNavOpen((open) => !open)}
            >
              <i className="bi bi-list" aria-hidden="true" />
            </button>
            <div className="ms-auto d-flex align-items-center gap-2">
              <AccountMenu />
              <LanguageSwitcher />
            </div>
          </header>
          <MaintenanceBanner />
          <RouteAnalytics />
          <main id="main" tabIndex={-1} className="flex-grow-1">
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
