import { safeNextPath } from '@cbi/web-core';
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { useCandidateAuth } from './session';
import { RouteLoading } from './RouteStates';

/** Only signed-in candidates; others go to /login and come back afterwards. */
export function RequireAuth() {
  const { status, signedOutByUser } = useCandidateAuth();
  const location = useLocation();
  if (status === 'loading') return <RouteLoading />;
  // After an explicit sign-out, go home rather than back to the sign-in form.
  if (status === 'signedOut' && signedOutByUser) return <Navigate to="/" replace />;
  if (status === 'signedOut') {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Outlet />;
}

/** Sends people who have not finished onboarding there first. */
export function RequireOnboarded() {
  const { user } = useCandidateAuth();
  if (user && !user.onboardingCompleted) return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}

/**
 * Sign-in pages are pointless when already signed in: continue to `?next=`
 * (through onboarding when it is not finished). Signing in lands here too, so
 * this is what returns a candidate to, for example, a campaign invite.
 */
export function RedirectIfSignedIn() {
  const { status, user } = useCandidateAuth();
  const [params] = useSearchParams();
  if (status === 'loading') return <RouteLoading />;
  if (status === 'signedIn') {
    const next = safeNextPath(params.get('next'));
    const to =
      user && !user.onboardingCompleted ? `/onboarding?next=${encodeURIComponent(next)}` : next;
    return <Navigate to={to} replace />;
  }
  return <Outlet />;
}
