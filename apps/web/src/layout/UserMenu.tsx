import { ChevronDown, LogOut } from 'lucide-react';
import { useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { Role } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { DEMO_USERS, roleLabel, type DemoUser } from '@/auth/demoUsers';
import { Avatar, Badge, Menu, useToast, type MenuGroup } from '@/components/ui';

const ROLE_HINT: Record<Role, string> = {
  manager: 'Sees the whole team and allocates leads',
  rep: 'Sees their own leads and the unallocated pool',
};

/** Pages only managers can open; a rep switched in on one of them lands on the dashboard. */
const MANAGER_PATHS = ['/allocation'];

export function RoleBadge({ role }: { role: Role }) {
  return <Badge variant={role === 'manager' ? 'accent' : 'neutral'}>{roleLabel(role)}</Badge>;
}

export function UserMenu() {
  const { user, demoMode, switchUser, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const switching = useRef(false);
  if (!user) return null;

  const switchTo = async (target: DemoUser) => {
    if (switching.current || target.email === user.email) return;
    switching.current = true;
    // Stay on the same page where the new user can see it: managers-only pages and team scopes are not for reps.
    if (target.role === 'rep') {
      const params = new URLSearchParams(location.search);
      const scope = params.get('scope');
      if (MANAGER_PATHS.some((p) => location.pathname.startsWith(p))) navigate('/', { replace: true });
      else if (scope && scope !== 'mine') {
        params.delete('scope');
        const qs = params.toString();
        navigate(`${location.pathname}${qs ? `?${qs}` : ''}`, { replace: true });
      }
    }
    try {
      const next = await switchUser(target.email);
      toast({ id: 'switch-user', variant: 'success', title: `Now viewing as ${next.name}`, description: `${roleLabel(next.role)} · ${ROLE_HINT[next.role]}` });
    } catch (err) {
      toast.error(err, `Still signed in as ${user.name}.`);
    } finally {
      switching.current = false;
    }
  };

  const groups: MenuGroup[] = demoMode
    ? [{
        label: 'Switch user',
        items: DEMO_USERS.map((u) => ({
          label: u.name,
          description: roleLabel(u.role),
          icon: <Avatar name={u.name} size={28} />,
          checked: u.email === user.email,
          onSelect: () => void switchTo(u),
        })),
      }]
    : [{ items: [{ label: 'Sign out', icon: <LogOut />, onSelect: () => logout('user') }] }];

  return (
    <Menu
      className="w-72"
      header={
        <div className="flex items-center gap-3">
          <Avatar name={user.name} size={40} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-fg">{user.name}</div>
            <div className="truncate text-xs text-muted">{user.email}</div>
            <div className="mt-1.5"><RoleBadge role={user.role} /></div>
          </div>
        </div>
      }
      groups={groups}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label={`Account menu for ${user.name}, ${roleLabel(user.role)}`}
          className="flex items-center gap-2 rounded-lg py-1 pr-1.5 pl-1 text-topbar-fg hover:bg-topbar-hover aria-expanded:bg-topbar-hover"
        >
          <Avatar name={user.name} size={32} />
          <span className="hidden text-left leading-tight xl:block">
            <span className="block text-sm font-medium">{user.name}</span>
            <span className="block text-xs text-topbar-muted">{roleLabel(user.role)}</span>
          </span>
          <ChevronDown className="size-4 text-topbar-muted" aria-hidden />
        </button>
      )}
    />
  );
}
