import type { SessionResponse } from '@cbi/shared-types';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SessionManager } from './session-manager';

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

export interface AuthContextValue<U> {
  status: AuthStatus;
  user: U | null;
  /** True when the current signed-out state came from the person signing out (not expiry). */
  signedOutByUser: boolean;
  manager: SessionManager;
  /** Completes sign-in with a session returned by an OTP/Google endpoint. */
  completeSignIn(session: SessionResponse): Promise<U>;
  /** Replace the cached user after a profile change. */
  setUser(user: U): void;
  signOut(): Promise<void>;
  signOutEverywhere(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue<unknown> | null>(null);

export interface AuthProviderProps<U> {
  manager: SessionManager;
  /**
   * Builds the app's user object from a session. Defaults to the session's
   * user; the admin app loads `/admin/me` to get permissions.
   */
  loadUser?: (session: SessionResponse, manager: SessionManager) => Promise<U>;
  children: ReactNode;
}

/**
 * Restores the session on load via the refresh cookie, then keeps React state
 * in sync with the session manager (expiry, sign-out in another code path).
 */
export function AuthProvider<U>({ manager, loadUser, children }: AuthProviderProps<U>) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUserState] = useState<U | null>(null);
  const [signedOutByUser, setSignedOutByUser] = useState(false);

  const resolveUser = useCallback(
    (session: SessionResponse) =>
      loadUser ? loadUser(session, manager) : Promise.resolve(session.user as U),
    [loadUser, manager],
  );

  useEffect(() => {
    let active = true;
    const unsubscribe = manager.subscribe((session) => {
      if (!session && active) {
        setUserState(null);
        setStatus('signedOut');
      }
    });
    manager
      .refresh()
      .then(async (session) => {
        if (!active) return;
        if (!session) {
          setStatus('signedOut');
          return;
        }
        const loaded = await resolveUser(session);
        if (!active) return;
        setUserState(loaded);
        setStatus('signedIn');
      })
      .catch(() => {
        if (active) setStatus('signedOut');
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [manager, resolveUser]);

  const value = useMemo<AuthContextValue<U>>(
    () => ({
      status,
      user,
      signedOutByUser,
      manager,
      async completeSignIn(session) {
        setSignedOutByUser(false);
        manager.start(session);
        const loaded = await resolveUser(session);
        setUserState(loaded);
        setStatus('signedIn');
        return loaded;
      },
      setUser: setUserState,
      signOut() {
        setSignedOutByUser(true);
        return manager.signOut();
      },
      signOutEverywhere() {
        setSignedOutByUser(true);
        return manager.signOutEverywhere();
      },
    }),
    [status, user, signedOutByUser, manager, resolveUser],
  );

  return (
    <AuthContext.Provider value={value as AuthContextValue<unknown>}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth<U>(): AuthContextValue<U> {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx as AuthContextValue<U>;
}
