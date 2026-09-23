import { Navigate, Outlet, useLocation } from 'react-router';
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

/** Sign-in pages are pointless when already signed in. */
export function RedirectIfSignedIn() {
  const { status } = useCandidateAuth();
  if (status === 'loading') return <RouteLoading />;
  if (status === 'signedIn') return <Navigate to="/app" replace />;
  return <Outlet />;
}
