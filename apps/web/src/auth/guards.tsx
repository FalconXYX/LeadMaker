import { KeyRound, RefreshCw } from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';
import { UnauthorizedError } from '@/api/client';
import { errorMessage } from '@/api/errors';
import { Button, Spinner, useToast } from '@/components/ui';
import { Logo } from '@/layout/Logo';
import { DEFAULT_DEMO_USER, DEMO_MODE } from '@/lib/config';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useAuth } from './AuthContext';
import { sessionStore } from './session';

/**
 * Renders the app for a signed-in user. Demo mode signs in silently (the last demo account used, else
 * VITE_DEFAULT_DEMO_USER); otherwise the identity provider takes over. The app remounts when the user
 * changes, so nothing from the previous user's screen survives a switch.
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { user } = useAuth();
  if (!user) return DEMO_MODE ? <DemoSignIn /> : <SignInRequired />;
  return <Fragment key={user.id}>{children ?? <Outlet />}</Fragment>;
}

function DemoSignIn() {
  const { login } = useAuth();
  // A session the API rejected straight after signing in would be rejected again: ask before retrying.
  const [rejected] = useState(sessionStore.recentlyRejected);
  const [error, setError] = useState<unknown>(rejected ? new Error('LeadMaker turned down the sign-in. Try again in a moment.') : null);
  const [attempt, setAttempt] = useState(0);
  useDocumentTitle('Signing in');

  useEffect(() => {
    if (rejected && attempt === 0) return;
    let live = true;
    const email = sessionStore.demoUser();
    // A remembered account that no longer exists falls back to the default one.
    login(email)
      .catch((err: unknown) => (err instanceof UnauthorizedError && email !== DEFAULT_DEMO_USER ? login(DEFAULT_DEMO_USER) : Promise.reject(err)))
      .catch((err: unknown) => {
        if (live) setError(err);
      });
    return () => {
      live = false;
    };
  }, [login, attempt, rejected]);

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4">
      <div className="flex max-w-sm flex-col items-center text-center">
        <Logo size={44} />
        {error ? (
          <>
            <h1 className="mt-5 text-lg font-semibold text-fg">Couldn’t open LeadMaker</h1>
            <p role="alert" className="mt-1.5 text-sm text-muted">{errorMessage(error)}</p>
            <Button
              variant="primary"
              className="mt-5"
              leftIcon={<RefreshCw className="size-4" aria-hidden />}
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </>
        ) : (
          // Usually gone in a blink: fade the message in only if signing in takes a moment.
          <p className="mt-5 flex items-center gap-2 text-sm text-muted opacity-0 animate-[lm-fade-in_200ms_ease-out_400ms_forwards]">
            <Spinner size={14} label="Signing in" /> Opening LeadMaker…
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Production sign-in (DEMO_MODE off). Not built yet: this is where the SSO redirect goes (send the browser to
 * the identity provider, exchange its callback for a gateway token, then sessionStore.set({ token, user })).
 */
function SignInRequired() {
  useDocumentTitle('Sign in');
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4">
      <div className="flex max-w-sm flex-col items-center text-center">
        <Logo size={44} />
        <h1 className="mt-5 text-lg font-semibold text-fg">Sign in with your company account</h1>
        <p className="mt-1.5 text-sm text-muted">
          Single sign-on is not set up for this deployment yet. Ask your administrator for access.
        </p>
        <span className="mt-5 inline-flex items-center gap-2 text-xs text-subtle">
          <KeyRound className="size-3.5" aria-hidden /> Demo sign-in is turned off
        </span>
      </div>
    </div>
  );
}

/** Managers only; reps are sent to the dashboard with a short explanation. */
export function RequireManager({ children }: { children?: ReactNode }) {
  const { isManager } = useAuth();
  if (!isManager) return <ManagersOnly />;
  return children ?? <Outlet />;
}

function ManagersOnly() {
  const toast = useToast();
  useEffect(() => {
    toast({ id: 'managers-only', variant: 'info', title: 'Allocation is for managers', description: 'Your manager assigns leads to you. Here is your dashboard.' });
  }, [toast]);
  return <Navigate to="/" replace />;
}
