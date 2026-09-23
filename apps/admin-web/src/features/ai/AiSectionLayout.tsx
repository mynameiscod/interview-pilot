import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';

const TABS = [
  { to: '/ai', key: 'ai.tabs.providers', end: true },
  { to: '/ai/models', key: 'ai.tabs.models' },
  { to: '/ai/routes', key: 'ai.tabs.routes' },
  { to: '/ai/health', key: 'ai.tabs.health' },
];

export function AiSectionLayout() {
  const { t } = useTranslation();
  return (
    <>
      <h1 className="h3 mb-2">{t('ai.title')}</h1>
      <p className="cb-text-secondary">{t('ai.subtitle')}</p>
      <nav aria-label={t('ai.tabsLabel')} className="mb-3">
        <ul className="nav nav-tabs">
          {TABS.map((tab) => (
            <li className="nav-item" key={tab.to}>
              <NavLink
                to={tab.to}
                end={tab.end}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              >
                {t(tab.key)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </>
  );
}
