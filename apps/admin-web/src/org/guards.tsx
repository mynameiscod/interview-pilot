import type { OrgPermission } from '@cbi/shared-types';
import { AuthProvider, safeNextPath, type SessionManager } from '@cbi/web-core';
import { useContext, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { RouteLoading } from '../app/guards';
import { loadOrgUser, OrgManagerContext, useOrgAuth, useOrgCan } from './session';

export function OrgManagerProvider({
  manager,
  children,
}: {
  manager: SessionManager;
  children: ReactNode;
}) {
  return <OrgManagerContext.Provider value={manager}>{children}</OrgManagerContext.Provider>;
}

/** The `/org` route tree: its own auth state, separate from the staff console's. */
export function OrgAuthRoot() {
  const manager = useContext(OrgManagerContext);
  if (!manager) throw new Error('OrgAuthRoot needs an <OrgManagerProvider>');
  return (
    <AuthProvider manager={manager} loadUser={loadOrgUser}>
      <Outlet />
    </AuthProvider>
  );
}

export function RequireOrgMember() {
  const { status, signedOutByUser } = useOrgAuth();
  const location = useLocation();
  if (status === 'loading') return <RouteLoading />;
  if (status === 'signedOut') {
    const next = signedOutByUser
      ? ''
      : `?next=${encodeURIComponent(location.pathname + location.search)}`;
    return <Navigate to={`/org/login${next}`} replace />;
  }
  return <Outlet />;
}

export function RedirectIfOrgSignedIn() {
  const { status } = useOrgAuth();
  const [params] = useSearchParams();
  if (status === 'loading') return <RouteLoading />;
  if (status === 'signedIn') {
    const next = safeNextPath(params.get('next'), '/org');
    return <Navigate to={next.startsWith('/org') ? next : '/org'} replace />;
  }
  return <Outlet />;
}

/** Hides a section from members without the permission (the API enforces it too). */
export function RequireOrgPermission({ permission }: { permission: OrgPermission }) {
  const { t } = useTranslation();
  if (!useOrgCan(permission)) {
    return (
      <div className="p-4 border cb-border rounded-3 bg-white" role="alert">
        <h1 className="h4">
          <i className="bi bi-shield-lock me-2" aria-hidden="true" />
          {t('forbidden.title')}
        </h1>
        <p className="cb-text-secondary mb-0">{t('orgPortal.forbidden')}</p>
      </div>
    );
  }
  return <Outlet />;
}
