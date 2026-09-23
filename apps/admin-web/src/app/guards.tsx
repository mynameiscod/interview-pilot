import type { Permission } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAdminAuth, useCan } from './session';

export function RouteLoading() {
  const { t } = useTranslation();
  return (
    <div className="p-5 d-flex justify-content-center" role="status">
      <div className="spinner-border text-primary" aria-hidden="true" />
      <span className="visually-hidden">{t('common.loading')}</span>
    </div>
  );
}

export function RequireAdmin() {
  const { status, signedOutByUser } = useAdminAuth();
  const location = useLocation();
  if (status === 'loading') return <RouteLoading />;
  if (status === 'signedOut') {
    const next = signedOutByUser
      ? ''
      : `?next=${encodeURIComponent(location.pathname + location.search)}`;
    return <Navigate to={`/login${next}`} replace />;
  }
  return <Outlet />;
}

export function RedirectIfSignedIn() {
  const { status } = useAdminAuth();
  if (status === 'loading') return <RouteLoading />;
  if (status === 'signedIn') return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Hides a section from admins without the permission (the API enforces it too). */
export function RequirePermission({ permission }: { permission: Permission }) {
  const { t } = useTranslation();
  const allowed = useCan(permission);
  if (!allowed) {
    return (
      <div className="p-4 border cb-border rounded-3 bg-white" role="alert">
        <h1 className="h4">
          <i className="bi bi-shield-lock me-2" aria-hidden="true" />
          {t('forbidden.title')}
        </h1>
        <p className="cb-text-secondary mb-0">{t('forbidden.body')}</p>
      </div>
    );
  }
  return <Outlet />;
}
