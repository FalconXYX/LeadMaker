import { Compass, TriangleAlert } from 'lucide-react';
import { lazy } from 'react';
import { Link, Navigate, createBrowserRouter, isRouteErrorResponse, useLocation, useRouteError, type RouteObject } from 'react-router';
import { RequireAuth, RequireManager } from '@/auth/guards';
import { Button, Card, EmptyState, buttonClasses } from '@/components/ui';
import { AppShell } from '@/layout/AppShell';
import { Page } from '@/layout/PageHeader';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

// Feature pages are code-split; each feature folder exports its page as a named export from index.tsx.
const DashboardPage = lazy(() => import('@/features/dashboard').then((m) => ({ default: m.DashboardPage })));
const LeadsPage = lazy(() => import('@/features/leads').then((m) => ({ default: m.LeadsPage })));
const LeadProfilePage = lazy(() => import('@/features/profile').then((m) => ({ default: m.LeadProfilePage })));
const AllocationPage = lazy(() => import('@/features/allocation').then((m) => ({ default: m.AllocationPage })));
const TasksPage = lazy(() => import('@/features/tasks').then((m) => ({ default: m.TasksPage })));
const AdminPage = lazy(() => import('@/features/admin').then((m) => ({ default: m.AdminPage })));

export const routes: RouteObject[] = [
  // Sign-in is silent (demo mode) or the identity provider's (production): old /login links go home.
  { path: '/login', element: <Navigate to="/" replace /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          {
            // A page that throws shows the error inside the shell, so the navigation stays usable.
            errorElement: <RouteError />,
            children: [
              { index: true, element: <DashboardPage /> },
              // Filter state lives in the query string: /leads?q=acme&segment=strategic&sort=rating:desc
              { path: 'leads', element: <LeadsPage /> },
              { path: 'leads/:id', element: <LeadProfilePage /> },
              { path: 'tasks', element: <TasksPage /> },
              { element: <RequireManager />, children: [{ path: 'allocation', element: <AllocationPage /> }] },
              {
                element: <RequireManager title="Admin is for managers" description="Your manager sets where LeadMaker finds leads. Here is your dashboard." />,
                children: [{ path: 'admin', element: <AdminPage /> }],
              },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);

function NotFound() {
  const { pathname } = useLocation();
  useDocumentTitle('Page not found');
  return (
    <Page>
      <Card>
        <EmptyState
          icon={<Compass />}
          title="Page not found"
          description={<>There is no page at <code className="rounded bg-surface-3 px-1 py-0.5 text-xs text-fg">{pathname}</code>. The link may be mistyped or out of date.</>}
          action={(
            <div className="flex flex-wrap justify-center gap-2">
              <Link to="/" className={buttonClasses('primary')}>Go to dashboard</Link>
              <Link to="/leads" className={buttonClasses('secondary')}>Browse leads</Link>
            </div>
          )}
        />
      </Card>
    </Page>
  );
}

/** Shown instead of a page that crashed (or a code chunk that failed to load after a deploy). */
function RouteError() {
  const error = useRouteError();
  useDocumentTitle('Something went wrong');
  const stale = error instanceof Error && /dynamically imported module|Importing a module script failed|Loading chunk/i.test(error.message);
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return (
    <Page>
      <Card>
        <EmptyState
          icon={<TriangleAlert />}
          title={stale ? 'LeadMaker was updated' : 'Something went wrong'}
          description={stale
            ? 'A newer version is available. Reload to continue where you were.'
            : 'This page hit an unexpected error. Reloading usually fixes it; your data is safe.'}
          action={(
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => window.location.reload()}>Reload</Button>
              <a href="/" className={buttonClasses('secondary')}>Go to dashboard</a>
            </div>
          )}
        />
      </Card>
    </Page>
  );
}
