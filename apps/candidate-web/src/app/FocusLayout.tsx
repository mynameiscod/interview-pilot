import { BrandLogo } from '@cbi/design-system';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { MaintenanceBanner } from '../components/MaintenanceBanner';
import { RouteAnalytics } from '../lib/use-analytics';

/**
 * Distraction-free shell for the interview room (design §12): the brand and
 * the language switcher only, no navigation away from the interview.
 */
export function FocusLayout() {
  const { t } = useTranslation();
  return (
    <>
      <a href="#main" className="cb-skip-link">
        {t('a11y.skipToContent')}
      </a>
      <header className="border-bottom cb-border bg-white">
        <div className="container-lg d-flex flex-wrap align-items-center justify-content-between gap-2 py-2">
          <span className="d-flex align-items-center gap-2">
            <BrandLogo asset="codebegunLogo" />
            <span className="fw-semibold text-primary">{t('app.productName')}</span>
          </span>
          <LanguageSwitcher />
        </div>
      </header>
      <MaintenanceBanner />
      <RouteAnalytics />
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
