import { BrandLogo } from '@cbi/design-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet } from 'react-router';
import { config } from '../config';

// Sections are added here as each phase delivers its admin module.
const NAV_ITEMS = [{ to: '/', key: 'nav.dashboard', icon: 'bi-speedometer2' }] as const;

const ENV_BADGE: Record<typeof config.appEnv, string> = {
  development: 'text-bg-secondary',
  test: 'text-bg-secondary',
  staging: 'text-bg-warning',
  production: 'text-bg-danger',
};

export function AdminLayout() {
  const { t } = useTranslation();
  const [navOpen, setNavOpen] = useState(false);

  return (
    <>
      <a href="#main" className="cb-skip-link">
        {t('a11y.skipToContent')}
      </a>
      <header className="navbar border-bottom cb-border bg-white px-3">
        <div className="d-flex align-items-center gap-2">
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm d-lg-none"
            aria-controls="admin-nav"
            aria-expanded={navOpen}
            aria-label={t('a11y.toggleNavigation')}
            onClick={() => setNavOpen((open) => !open)}
          >
            <i className="bi bi-list" aria-hidden="true" />
          </button>
          <Link
            to="/"
            className="d-flex align-items-center gap-2 text-decoration-none"
            aria-label={t('app.homeLink')}
          >
            <BrandLogo asset="codebegunLogo" />
            <span className="fw-semibold text-primary">{t('app.consoleName')}</span>
          </Link>
        </div>
        <span className={`badge ${ENV_BADGE[config.appEnv]}`}>{t(`env.${config.appEnv}`)}</span>
      </header>
      <div className="d-lg-flex">
        <nav
          id="admin-nav"
          aria-label={t('a11y.adminNavigation')}
          className={`cb-surface-muted border-end cb-border p-3 flex-shrink-0 ${navOpen ? '' : 'd-none'} d-lg-block`}
          style={{ minWidth: '14rem' }}
        >
          <ul className="nav nav-pills flex-column gap-1">
            {NAV_ITEMS.map((item) => (
              <li className="nav-item" key={item.to}>
                <NavLink
                  to={item.to}
                  end
                  className={({ isActive }) => `nav-link ${isActive ? 'active' : 'link-dark'}`}
                  onClick={() => setNavOpen(false)}
                >
                  <i className={`bi ${item.icon} me-2`} aria-hidden="true" />
                  {t(item.key)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1} className="flex-grow-1 p-3 p-lg-4">
          <Outlet />
        </main>
      </div>
    </>
  );
}
