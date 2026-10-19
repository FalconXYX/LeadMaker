import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { UnauthorizedError } from '@/api/client';
import { getMe } from '@/api/endpoints';
import type { SessionUser } from '@/api/types';
import { DEMO_MODE } from '@/lib/config';
import { canAllocate, canWrite, isManager } from './permissions';
import { isSessionUser, sessionStore, signInAs, tokenClaims, type LogoutReason } from './session';

/** Demo mode renews this long before the token expires. */
const RENEW_BEFORE_MS = 2 * 60_000;

export interface AuthContextValue {
  user: SessionUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isManager: boolean;
  /** Demo mode: silent sign-in and "Switch user". */
  demoMode: boolean;
  /** Dev login (DEMO_MODE): POST /auth/dev-login {email}. */
  login: (email: string) => Promise<SessionUser>;
  /** Signs in as another demo account; the previous user's cached data is dropped before the switch. */
  switchUser: (email: string) => Promise<SessionUser>;
  logout: (reason?: LogoutReason) => void;
  /** Why the last session ended. */
  logoutReason: LogoutReason | null;
  canWrite: (lead: Parameters<typeof canWrite>[1]) => boolean;
  canAllocate: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get, sessionStore.get);
  const user = session?.user ?? null;
  const token = session?.token ?? null;
  const previousToken = useRef(token);

  // A different user (or none) must never see the previous user's cached data: the cache is dropped before
  // the new session is published (and RequireAuth remounts the app for the new user).
  useEffect(() => sessionStore.onUserChange(() => qc.clear()), [qc]);

  // A renewed token keeps the cache; retry whatever the rejected token broke.
  useEffect(() => {
    const prev = previousToken.current;
    previousToken.current = token;
    if (prev && token && prev !== token) void qc.invalidateQueries({ predicate: (q) => q.state.status === 'error' });
  }, [token, qc]);

  // Revalidate a restored session once (role or name may have changed; deleted users get a 401).
  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    getMe({ signal: ctrl.signal }).then(
      (me) => {
        const s = sessionStore.get();
        if (s && s.token === token && isSessionUser(me) && JSON.stringify(s.user) !== JSON.stringify(me)) {
          sessionStore.set({ token, user: me });
        }
      },
      (err: unknown) => {
        if (err instanceof UnauthorizedError && sessionStore.get()?.token === token) sessionStore.set(null, 'expired');
      },
    );
    return () => ctrl.abort();
  }, [token]);

  // Demo mode renews shortly before the token expires; otherwise the session ends the moment it does
  // (rather than on the next request from an idle tab or the SSE stream).
  useEffect(() => {
    if (!token) return;
    const exp = tokenClaims(token)?.exp;
    if (typeof exp !== 'number') return;
    const ms = exp * 1000 - Date.now() - (DEMO_MODE ? RENEW_BEFORE_MS : 0);
    // setTimeout caps at ~24.8 days; longer tokens are checked again when they get closer.
    const t = setTimeout(() => {
      if (sessionStore.get()?.token !== token) return;
      if (DEMO_MODE) void sessionStore.renew();
      else sessionStore.set(null, 'expired');
    }, Math.min(Math.max(0, ms), 2_000_000_000));
    return () => clearTimeout(t);
  }, [token]);

  const login = useCallback((email: string) => signInAs(email), []);

  const logout = useCallback((reason: LogoutReason = 'user') => sessionStore.set(null, reason), []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    token,
    isAuthenticated: !!user,
    isManager: isManager(user),
    demoMode: DEMO_MODE,
    login,
    switchUser: login,
    logout,
    logoutReason: user ? null : sessionStore.lastLogoutReason(),
    canWrite: (lead) => canWrite(user, lead),
    canAllocate: canAllocate(user),
  }), [user, token, login, logout]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in user; only call below <RequireAuth>. */
export function useUser(): SessionUser {
  const { user } = useAuth();
  if (!user) throw new Error('useUser called without a signed-in user');
  return user;
}
