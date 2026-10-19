// The signed-in session: an external store (token + user) persisted to localStorage, read by the API
// client for the bearer token and by AuthProvider via useSyncExternalStore.
//
// Demo mode signs in through POST /auth/dev-login and renews silently: a rejected or expiring token signs
// the same user in again instead of ending the session. Without demo mode a rejected token ends the session.
import { configureApiClient } from '@/api/client';
import { devLogin } from '@/api/endpoints';
import type { SessionUser } from '@/api/types';
import { DEFAULT_DEMO_USER, DEMO_MODE } from '@/lib/config';
import { safeStorage } from '@/lib/storage';

const KEY = 'leadmaker.session';
/** The last demo account used, so an expired session comes back as the same person. */
const DEMO_USER_KEY = 'leadmaker.demoUser';
/** A token renewed this recently and rejected again is not renewed a second time (no sign-in loops). */
const RENEW_COOLDOWN_MS = 10_000;

export interface Session {
  token: string;
  user: SessionUser;
}

export type LogoutReason = 'user' | 'expired';

type Listener = () => void;

let current: Session | null = load();
let lastLogoutReason: LogoutReason | null = null;
let renewing: Promise<void> | null = null;
let lastRenewAt = 0;
let lastSignInAt = 0;
const signingIn = new Map<string, Promise<SessionUser>>();
const listeners = new Set<Listener>();
const userChangeHooks = new Set<Listener>();

const userIdOf = (s: Session | null) => s?.user.id ?? null;

/** Runs before a different user (or none) is published, so nothing renders the previous user's data. */
function beforeUserChange(prev: Session | null, next: Session | null): void {
  if (userIdOf(prev) !== userIdOf(next)) userChangeHooks.forEach((h) => h());
}

function load(): Session | null {
  const s = safeStorage.getJson<Session>(KEY);
  if (!s || typeof s.token !== 'string' || !s.user || typeof s.user.id !== 'string') return null;
  if (isTokenExpired(s.token)) {
    safeStorage.remove(KEY);
    return null;
  }
  return s;
}

function write(next: Session | null, reason: LogoutReason = 'user'): void {
  if (next === current) return;
  beforeUserChange(current, next);
  current = next;
  if (next) {
    lastSignInAt = Date.now();
    safeStorage.setJson(KEY, next);
    if (DEMO_MODE && next.user.email) safeStorage.set(DEMO_USER_KEY, next.user.email);
    lastLogoutReason = null;
  } else {
    safeStorage.remove(KEY);
    lastLogoutReason = reason;
  }
  listeners.forEach((l) => l());
}

export function isSessionUser(v: unknown): v is SessionUser {
  const u = v as Partial<SessionUser> | null;
  return !!u && typeof u.id === 'string' && typeof u.name === 'string' && (u.role === 'rep' || u.role === 'manager');
}

/** Dev login (DEMO_MODE): POST /auth/dev-login {email}. Concurrent calls for the same email share one request. */
export function signInAs(email: string): Promise<SessionUser> {
  const address = email.trim().toLowerCase();
  const pending = signingIn.get(address);
  if (pending) return pending;
  const p = devLogin(address)
    .then((res) => {
      if (!res || typeof res.token !== 'string' || !isSessionUser(res.user)) throw new Error('Unexpected sign-in response.');
      write({ token: res.token, user: res.user });
      return res.user;
    })
    .finally(() => signingIn.delete(address));
  signingIn.set(address, p);
  return p;
}

/** Signs the current user in again with a fresh token; ends the session if that fails. */
function renew(): Promise<void> {
  const s = current;
  if (!s) return Promise.resolve();
  if (renewing) return renewing;
  if (Date.now() - lastRenewAt < RENEW_COOLDOWN_MS) {
    write(null, 'expired');
    return Promise.resolve();
  }
  lastRenewAt = Date.now();
  renewing = devLogin(s.user.email)
    .then(
      (res) => {
        if (current !== s) return;
        write(res && typeof res.token === 'string' && isSessionUser(res.user) ? { token: res.token, user: res.user } : null, 'expired');
      },
      () => {
        if (current === s) write(null, 'expired');
      },
    )
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

export const sessionStore = {
  get: (): Session | null => current,
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /**
   * set(null, 'expired') is what every caller does on a 401. In demo mode that renews the session for the
   * same user in the background (the old session stays until the new token arrives).
   */
  set(next: Session | null, reason: LogoutReason = 'user'): void {
    if (next === null && reason === 'expired' && DEMO_MODE && current) {
      void renew();
      return;
    }
    write(next, reason);
  },
  /** Renew ahead of expiry (demo mode). */
  renew,
  isRenewing: () => renewing !== null,
  /** The last session was rejected moments after it started: signing in again would only loop. */
  recentlyRejected: () => lastLogoutReason === 'expired' && Date.now() - lastSignInAt < RENEW_COOLDOWN_MS,
  lastLogoutReason: () => lastLogoutReason,
  /** Who demo mode signs in as when there is no session: the last account used, else VITE_DEFAULT_DEMO_USER. */
  demoUser: (): string => safeStorage.get(DEMO_USER_KEY) || DEFAULT_DEMO_USER,
  /** Called synchronously before a different user (or none) is published; returns an unsubscribe. */
  onUserChange(fn: Listener): () => void {
    userChangeHooks.add(fn);
    return () => userChangeHooks.delete(fn);
  },
  /** Re-reads storage (tests; another tab signing in or out). */
  reload(): void {
    const next = load();
    beforeUserChange(current, next);
    current = next;
    listeners.forEach((l) => l());
  },
  /** Tests: forget renewals and the remembered demo account. */
  resetForTests(): void {
    renewing = null;
    lastRenewAt = 0;
    lastSignInAt = 0;
    lastLogoutReason = null;
    signingIn.clear();
    safeStorage.remove(DEMO_USER_KEY);
  },
};

/** Decodes the JWT payload (no verification: the gateway verifies). */
export function tokenClaims(token: string): { exp?: number; sub?: string; role?: string; name?: string } | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(b64)) as { exp?: number };
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string, skewMs = 10_000): boolean {
  const exp = tokenClaims(token)?.exp;
  return typeof exp === 'number' && exp * 1000 - skewMs <= Date.now();
}

configureApiClient({
  getToken: () => current?.token ?? null,
  onUnauthorized: () => sessionStore.set(null, 'expired'),
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) sessionStore.reload();
  });
}
