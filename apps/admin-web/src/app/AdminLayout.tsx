import { BrandLogo } from '@cbi/design-system';
import type { Permission } from '@cbi/shared-types';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet } from 'react-router';
import { config } from '../config';
import { useAdminAuth } from './session';

// Sections are added here as each phase delivers its admin module.
const NAV_ITEMS: { to: string; key: string; icon: string; permission?: Permission }[] = [
  { to: '/', key: 'nav.dashboard', icon: 'bi-speedometer2' },
  { to: '/admins', key: 'nav.admins', icon: 'bi-people', permission: 'admin_users.read' },
  { to: '/ai', key: 'nav.ai', icon: 'bi-cpu', permission: 'ai.read' },
  { to: '/ai-usage', key: 'nav.aiUsage', icon: 'bi-graph-up', permission: 'ai_usage.read' },
  { to: '/prompts', key: 'nav.prompts', icon: 'bi-chat-square-text', permission: 'prompts.read' },
  { to: '/audit', key: 'nav.audit', icon: 'bi-journal-text', permission: 'audit.read' },
];

const ENV_BADGE: Record<typeof config.appEnv, string> = {
  development: 'text-bg-secondary',
  test: 'text-bg-secondary',
  staging: 'text-bg-warning',
  production: 'text-bg-danger',
};

export function AdminLayout() {
  const { t } = useTranslation();
  const { user, signOut } = useAdminAuth();
  const [navOpen, setNavOpen] = useState(false);
  const items = NAV_ITEMS.filter(
    (item) => !item.permission || user?.permissions.includes(item.permission),
  );

  return (
    <>
      <a href="#main" className="cb-skip-link">
        {t('a11y.skipToContent')}
      </a>
      <header className="navbar border-bottom cb-border bg-white px-3 gap-2">
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
        <div className="d-flex align-items-center gap-2">
          <span className={`badge ${ENV_BADGE[config.appEnv]}`}>{t(`env.${config.appEnv}`)}</span>
          {user && (
            <>
              <span
                className="small cb-text-secondary d-none d-md-inline text-truncate"
                style={{ maxWidth: '16rem' }}
              >
                {user.email}
              </span>
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                onClick={() => void signOut().catch(() => undefined)}
              >
                {t('nav.signOut')}
              </button>
            </>
          )}
        </div>
      </header>
      <div className="d-lg-flex">
        <nav
          id="admin-nav"
          aria-label={t('a11y.adminNavigation')}
          className={`cb-surface-muted border-end cb-border p-3 flex-shrink-0 ${navOpen ? '' : 'd-none'} d-lg-block`}
          style={{ minWidth: '14rem' }}
        >
          <ul className="nav nav-pills flex-column gap-1">
            {items.map((item) => (
              <li className="nav-item" key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
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
        <main id="main" tabIndex={-1} className="flex-grow-1 p-3 p-lg-4" style={{ minWidth: 0 }}>
          <Outlet />
        </main>
      </div>
    </>
  );
}
