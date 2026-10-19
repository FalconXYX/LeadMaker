import { Building2, LayoutDashboard, ListChecks, Menu as MenuIcon, Shuffle, X, type LucideIcon } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '@/auth/AuthContext';
import { Spinner } from '@/components/ui';
import { AssistantLauncher } from '@/features/assistant';
import { NotificationBell } from '@/features/notifications';
import { useEventStream } from '@/live/useEventStream';
import { cn } from '@/lib/cn';
import { GlobalSearch } from './GlobalSearch';
import { Logo } from './Logo';
import { UserMenu } from './UserMenu';

export { Logo } from './Logo';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  managerOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/leads', label: 'Leads', icon: Building2 },
  { to: '/tasks', label: 'Tasks', icon: ListChecks },
  { to: '/allocation', label: 'Allocation', icon: Shuffle, managerOnly: true },
];

export function AppShell() {
  const { token, isManager } = useAuth();
  // Live updates keep lists, counts and notifications fresh in the background; the shell shows no indicator.
  useEventStream(token);
  const items = NAV.filter((n) => !n.managerOnly || isManager);

  return (
    <div className="flex h-full flex-col">
      <a href="#main" className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>

      <header className="relative z-40 shrink-0 bg-topbar text-topbar-fg shadow-md">
        <div className="flex h-14 items-center gap-1 px-3 sm:gap-1.5 sm:px-6 lg:px-10">
          <PhoneNav items={items} />
          <Link to="/" aria-label="LeadMaker home" className="flex shrink-0 items-center gap-2.5 rounded-lg py-1 pr-2 pl-1 hover:bg-topbar-hover">
            <Logo size={30} />
            <span className="text-base font-semibold tracking-tight">LeadMaker</span>
          </Link>

          <nav aria-label="Primary" className="ml-4 hidden items-center gap-1.5 md:flex lg:ml-8">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => cn(
                  'inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
                  isActive ? 'bg-accent text-accent-fg shadow-sm' : 'text-topbar-muted hover:bg-topbar-hover hover:text-topbar-fg',
                )}
              >
                <item.icon className="size-4 shrink-0" aria-hidden />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
            <GlobalSearch />
            <span className="lm-topbar-scope flex">
              <NotificationBell />
            </span>
            <UserMenu />
          </div>
        </div>
      </header>

      {/* relative: absolutely positioned content (sr-only labels) stays inside this scroller instead of
          stretching the document, which otherwise scrolls the whole shell away over blank space. */}
      <main id="main" tabIndex={-1} className="relative min-h-0 flex-1 overflow-y-auto pb-24 outline-none">
        <Suspense fallback={<div className="flex h-64 items-center justify-center text-muted"><Spinner size={20} /></div>}>
          <Outlet />
        </Suspense>
      </main>

      <AssistantLauncher />
    </div>
  );
}

/** Phones and small tablets: the nav folds into a menu under the top bar. */
function PhoneNav({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="md:hidden">
      <button
        ref={button}
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="phone-nav"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-10 items-center justify-center rounded-lg text-topbar-fg hover:bg-topbar-hover"
      >
        {open ? <X className="size-5" aria-hidden /> : <MenuIcon className="size-5" aria-hidden />}
      </button>
      {open && (
        <nav
          id="phone-nav"
          aria-label="Primary"
          className="absolute inset-x-0 top-14 border-b border-border bg-surface px-3 py-2.5 text-fg shadow-lg animate-[lm-pop-in_120ms_ease-out]"
        >
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => cn(
                'flex h-12 items-center gap-3 rounded-lg px-3 text-base font-medium',
                isActive ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-hover',
              )}
            >
              <item.icon className="size-5 shrink-0" aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
