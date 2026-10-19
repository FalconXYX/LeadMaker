import { ArrowRight, CalendarCheck, CalendarClock, ClipboardCheck, Clock3, PartyPopper, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useUsers } from '@/api/queries';
import type { LeadFilter } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { Card, EmptyState, Segmented, Select, Tab, TabList, TabPanel, Tabs, buttonClasses } from '@/components/ui';
import { Page, PageHeader } from '@/layout/PageHeader';
import { cn } from '@/lib/cn';
import { filterToSearchParams } from '@/lib/filterUrl';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import type { TaskDue, TaskScope, TaskStatus } from './api';
import { TaskList } from './TaskList';
import { useTaskCounts, type TaskCounts } from './queries';

export type TasksTab = 'overdue' | 'today' | 'week' | 'upcoming' | 'done';

const TABS: { value: TasksTab; label: string; due: TaskDue; status: TaskStatus }[] = [
  { value: 'overdue', label: 'Overdue', due: 'overdue', status: 'open' },
  { value: 'today', label: 'Today', due: 'today', status: 'open' },
  { value: 'week', label: 'This week', due: 'week', status: 'open' },
  { value: 'upcoming', label: 'Upcoming', due: 'upcoming', status: 'open' },
  { value: 'done', label: 'Done', due: 'all', status: 'done' },
];

const isTab = (v: string | null): v is TasksTab => TABS.some((t) => t.value === v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ?scope= for managers (mine | team | rep:<id>); reps always see their own. */
export function parseScope(raw: string | null, isManager: boolean): TaskScope {
  if (!isManager) return 'mine';
  if (raw === 'team') return 'team';
  if (raw?.startsWith('rep:') && UUID.test(raw.slice(4))) return raw as TaskScope;
  return 'mine';
}

const leadScope = (scope: TaskScope): LeadFilter['scope'] =>
  scope === 'mine' ? 'mine' : scope === 'team' ? 'all' : { repId: scope.slice(4) };

const leadsHref = (filter: LeadFilter) => `/leads?${filterToSearchParams(filter)}`;

/** /tasks: "My follow-ups" (managers: the team's or one rep's), by due date, with a Log button on every row. */
export function TasksPage() {
  const { user, isManager } = useAuth();
  const [params, setParams] = useSearchParams();
  const scope = parseScope(params.get('scope'), isManager);
  const users = useUsers('rep', { enabled: isManager });
  const repId = scope.startsWith('rep:') ? scope.slice(4) : '';
  const rep = users.data?.items.find((u) => u.id === repId);
  const { counts } = useTaskCounts(scope);

  const tabParam = params.get('tab');
  const defaulted = useRef(false);
  // No tab in the URL: start on Overdue when anything is, else Today; chosen once, so finishing the last
  // overdue follow-up doesn't yank the list away.
  useEffect(() => {
    if (isTab(tabParam) || defaulted.current || !counts) return;
    defaulted.current = true;
    setTab(counts.overdue > 0 ? 'overdue' : 'today', true);
  });
  const tab: TasksTab = isTab(tabParam) ? tabParam : counts && counts.overdue > 0 ? 'overdue' : 'today';
  const current = TABS.find((t) => t.value === tab)!;

  function setTab(next: TasksTab, replace = false) {
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set('tab', next);
      return n;
    }, { replace });
  }
  const setScope = (next: TaskScope) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (next === 'mine') n.delete('scope');
      else n.set('scope', next);
      return n;
    });
  };

  const whose = scope === 'mine' ? 'My' : scope === 'team' ? 'Team' : rep ? `${rep.name.split(' ')[0]}’s` : 'Rep’s';
  const title = `${whose} follow-ups`;
  useDocumentTitle(title);

  return (
    <Page>
      <PageHeader
        title={title}
        description={<Summary counts={counts} scope={scope} firstName={rep?.name.split(' ')[0]} />}
        actions={isManager && (
          <div className="flex flex-wrap items-center gap-2.5">
            <Segmented
              label="Whose follow-ups"
              value={scope === 'mine' || scope === 'team' ? scope : null}
              onChange={setScope}
              options={[{ value: 'mine', label: 'Mine' }, { value: 'team', label: 'Team' }]}
            />
            <Select
              aria-label="One rep's follow-ups"
              selectSize="md"
              placeholder="Pick a rep…"
              value={repId}
              onValueChange={(id) => setScope(id ? `rep:${id}` : 'mine')}
              options={(users.data?.items ?? []).map((u) => ({ value: u.id, label: u.name }))}
              className="min-w-44"
            />
          </div>
        )}
      />

      <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_20rem] xl:gap-8">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TasksTab)} className="min-w-0">
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabList aria-label="Follow-ups by due date" className="min-w-max">
              {TABS.map((t) => (
                <Tab key={t.value} value={t.value}>
                  {t.label}{' '}
                  <TabCount tab={t.value} counts={counts} selected={tab === t.value} />
                </Tab>
              ))}
            </TabList>
          </div>
          <TabPanel value={tab} className="mt-5">
            {tab === 'done' && counts && (
              <p className="mb-2.5 text-sm text-muted">
                {counts.done === 0 ? 'Nothing ticked off in the last 7 days yet.' : `${counts.done}${counts.doneCapped ? '+' : ''} done in the last 7 days. Nice work.`}
              </p>
            )}
            <Card className="overflow-visible">
              <TaskList
                key={`${scope}:${tab}`}
                scope={scope}
                due={current.due}
                status={current.status}
                empty={<TabEmpty tab={tab} scope={scope} onTab={setTab} counts={counts} />}
              />
            </Card>
          </TabPanel>
        </Tabs>

        <aside aria-label="Find more people to call" className="flex flex-col gap-5">
          <NextCallsCard scope={scope} isMine={scope === 'mine' || (!!user && repId === user.id)} />
        </aside>
      </div>
    </Page>
  );
}

function Summary({ counts, scope, firstName }: { counts: TaskCounts | undefined; scope: TaskScope; firstName?: string }) {
  if (!counts) return <>Calls, emails and visits lined up, by when they’re due.</>;
  const who = scope === 'mine' ? 'You have' : scope === 'team' ? 'The team has' : `${firstName ?? 'This rep'} has`;
  const parts = [
    counts.overdue > 0 && `${counts.overdue} overdue`,
    counts.today > 0 && `${counts.today} due today`,
  ].filter(Boolean);
  if (parts.length) {
    return (
      <>
        {who} {parts.join(' and ')}.{counts.overdue > 0 ? ' Start with the overdue ones.' : ''}
      </>
    );
  }
  const later = counts.week > 0 ? ` ${counts.week} more coming up this week.` : '';
  return <>{scope === 'mine' ? 'You’re all caught up.' : 'All caught up.'}{later}</>;
}

function TabCount({ tab, counts, selected }: { tab: TasksTab; counts: TaskCounts | undefined; selected: boolean }) {
  if (!counts) return null;
  const n = counts[tab];
  const capped = tab === 'done' ? counts.doneCapped : counts.capped && tab !== 'overdue' && tab !== 'today';
  const alarm = tab === 'overdue' && n > 0;
  return (
    <span
      className={cn(
        'rounded-full px-1.5 text-xs font-semibold tabular',
        alarm ? 'bg-danger-soft text-danger' : selected ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted',
      )}
    >
      {n}{capped ? '+' : ''}
    </span>
  );
}

function TabEmpty({
  tab, scope, onTab, counts,
}: { tab: TasksTab; scope: TaskScope; onTab: (t: TasksTab) => void; counts: TaskCounts | undefined }) {
  const mine = scope === 'mine';
  const findLeads = (
    <Link to={leadsHref({ scope: leadScope(scope), followUp: 'none', sort: { by: 'priority_score', dir: 'desc' } })} className={buttonClasses('primary', 'md')}>
      <Search className="size-4" aria-hidden /> Find leads with no next step
    </Link>
  );
  const goToday = counts && counts.today > 0
    ? <button type="button" className={buttonClasses('secondary', 'md')} onClick={() => onTab('today')}>See today’s {counts.today}</button>
    : findLeads;
  const states: Record<TasksTab, { icon: ReactNode; title: string; description: string; action?: ReactNode }> = {
    overdue: {
      icon: <PartyPopper />,
      title: 'Nothing overdue',
      description: mine ? 'Every follow-up you promised is on time. Keep it that way.' : 'No one is behind on a follow-up.',
      action: goToday,
    },
    today: {
      icon: <CalendarCheck />,
      title: 'Nothing due today',
      description: mine
        ? 'A good day to call contractors you haven’t spoken to yet. Your best-ranked leads without a next step are a click away.'
        : 'No follow-ups are due today.',
      action: findLeads,
    },
    week: {
      icon: <CalendarClock />,
      title: 'Nothing planned this week',
      description: 'When you log a call, schedule the next step: it lands here so nothing slips.',
      action: findLeads,
    },
    upcoming: {
      icon: <Clock3 />,
      title: 'No upcoming follow-ups',
      description: 'Plan ahead: after each call, set a date for the next one.',
      action: findLeads,
    },
    done: {
      icon: <ClipboardCheck />,
      title: 'Nothing done yet',
      description: 'Tick off a follow-up and it shows up here, so you can see what you got through.',
    },
  };
  const s = states[tab];
  return <EmptyState icon={s.icon} title={s.title} description={s.description} action={s.action} />;
}

function NextCallsCard({ scope, isMine }: { scope: TaskScope; isMine: boolean }) {
  const links = useMemo(() => {
    const s = leadScope(scope);
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    return [
      {
        label: 'No next step yet',
        hint: isMine ? 'Your leads with nothing scheduled, best first' : 'Leads with nothing scheduled, best first',
        to: leadsHref({ scope: s, followUp: 'none', sort: { by: 'priority_score', dir: 'desc' } }),
      },
      {
        label: 'Quotes to chase',
        hint: 'Leads in Quoting, longest since contact first',
        to: leadsHref({ scope: s, stages: ['quoting'], sort: { by: 'last_contacted', dir: 'asc' } }),
      },
      {
        label: 'Gone quiet',
        hint: 'Interested leads not contacted in 30 days',
        to: leadsHref({ scope: s, stages: ['interested'], notContactedSince: monthAgo, sort: { by: 'last_contacted', dir: 'asc' } }),
      },
      {
        label: 'Never contacted',
        hint: 'New leads waiting for a first call',
        to: leadsHref({ scope: s, stages: ['new'], sort: { by: 'priority_score', dir: 'desc' } }),
      },
    ];
  }, [scope, isMine]);
  return (
    <Card>
      <div className="border-b border-divider px-4 py-3.5 sm:px-5 sm:py-4">
        <h2 className="text-sm font-semibold text-fg">Need more calls to make?</h2>
        <p className="mt-1 text-xs text-muted">Jump to the leads that need a nudge.</p>
      </div>
      <ul className="divide-y divide-divider">
        {links.map((l) => (
          <li key={l.label}>
            <Link to={l.to} className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-hover sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg group-hover:text-accent">{l.label}</span>
                <span className="block text-xs text-muted">{l.hint}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-subtle group-hover:text-accent" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
