import { BrandLogo } from '@cbi/design-system';
import type { OrgPermission } from '@cbi/shared-types';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet } from 'react-router';
import { useOrgAuth } from './session';

type NavItem = {
  to: string;
  key: string;
  icon: string;
  permission: OrgPermission;
  /** Colleges only (cohort readiness). */
  college?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { to: '/org', key: 'orgPortal.nav.campaigns', icon: 'bi-megaphone', permission: 'org.read' },
  {
    to: '/org/cohort',
    key: 'orgPortal.nav.cohort',
    icon: 'bi-mortarboard',
    permission: 'org.read',
    college: true,
  },
  { to: '/org/team', key: 'orgPortal.nav.team', icon: 'bi-people', permission: 'org.read' },
  {
    to: '/org/integrations',
    key: 'orgPortal.nav.integrations',
    icon: 'bi-plug',
    permission: 'org.integrations.manage',
  },
];

/** The org portal shell: the organisation's name, its own navigation and sign-out. */
export function OrgLayout() {
  const { t } = useTranslation();
  const { user, signOut } = useOrgAuth();
  const [navOpen, setNavOpen] = useState(false);
  const items = NAV_ITEMS.filter(
    (item) =>
      user?.orgPermissions.includes(item.permission) &&
      (!item.college || user.org.type === 'COLLEGE'),
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
            aria-controls="org-nav"
            aria-expanded={navOpen}
            aria-label={t('a11y.toggleNavigation')}
            onClick={() => setNavOpen((open) => !open)}
          >
            <i className="bi bi-list" aria-hidden="true" />
          </button>
          <Link
            to="/org"
            className="d-flex align-items-center gap-2 text-decoration-none"
            aria-label={t('orgPortal.homeLink')}
          >
            <BrandLogo asset="codebegunLogo" />
            <span className="fw-semibold text-primary">{user?.org.name}</span>
          </Link>
          {user && (
            <span className="badge text-bg-light border cb-border">
              {t(`orgPortal.orgTypes.${user.org.type}`)}
            </span>
          )}
        </div>
        <div className="d-flex align-items-center gap-2">
          {user && (
            <>
              <span
                className="small cb-text-secondary d-none d-md-inline text-truncate"
                style={{ maxWidth: '16rem' }}
              >
                {user.email} · {t(`orgPortal.roles.${user.orgRole}`)}
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
          id="org-nav"
          aria-label={t('orgPortal.navLabel')}
          className={`cb-surface-muted border-end cb-border p-3 flex-shrink-0 ${navOpen ? '' : 'd-none'} d-lg-block`}
          style={{ minWidth: '14rem' }}
        >
          <ul className="nav nav-pills flex-column gap-1">
            {items.map((item) => (
              <li className="nav-item" key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/org'}
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
