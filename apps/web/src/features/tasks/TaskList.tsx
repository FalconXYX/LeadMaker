import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck, ExternalLink, MoreHorizontal, NotebookPen, Phone, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '@/api/errors';
import { Avatar, Button, EmptyState, ErrorState, IconButton, Menu, Skeleton, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { createTask } from '@/api/endpoints';
import type { Task, TaskDue, TaskScope, TaskStatus } from './api';
import { BUCKETS, BUCKET_LABELS, bucketOf, daysBetween, doneText, dueText, formatDay, salesDay, today, type Bucket } from './dates';
import { LogActivityDialog } from './LogActivityDialog';
import { TASK_TYPE_META, activityKindOf, formatPhone, telHref } from './model';
import { CompleteToggle, DueButton, RescheduleMenu, TaskTypeIcon } from './parts';
import {
  invalidateAfterTaskWrite, useCompleteTask, useDeleteTask, useInfiniteTasks, useLeadPhone, useRescheduleTask, useTasks,
} from './queries';

export interface TaskListProps {
  scope: TaskScope;
  due: TaskDue;
  compact?: boolean;
  /** Rows per page (compact: the most shown, with a "See all" link). */
  limit?: number;
  status?: TaskStatus;
  /** Show whose task each row is (default: the team scope). */
  showAssignee?: boolean;
  /** Replaces the default empty message. */
  empty?: ReactNode;
  /** Compact only: where "See all" goes (default /tasks on the matching tab). */
  seeAllHref?: string;
  className?: string;
}

const DUE_TAB: Record<TaskDue, string> = { overdue: 'overdue', today: 'today', week: 'week', upcoming: 'upcoming', all: 'today' };

type Group = { key: string; label: string; tone: 'overdue' | 'today' | 'normal'; items: Task[] };

function groupOpen(items: Task[], now: Date): Group[] {
  const by = new Map<Bucket, Task[]>();
  for (const t of items) {
    const b = bucketOf(t.dueAt, now);
    by.set(b, [...(by.get(b) ?? []), t]);
  }
  return BUCKETS.filter((b) => by.has(b)).map((b) => ({
    key: b, label: BUCKET_LABELS[b], tone: b === 'overdue' ? 'overdue' : b === 'today' ? 'today' : 'normal', items: by.get(b)!,
  }));
}

function groupDone(items: Task[], now: Date): Group[] {
  const day = today(now);
  const labels = ['Today', 'Yesterday', 'Earlier this week', 'Older'] as const;
  const by = new Map<string, Task[]>();
  for (const t of items) {
    const d = t.doneAt ? daysBetween(salesDay(t.doneAt), day) : 99;
    const label = d <= 0 ? labels[0] : d === 1 ? labels[1] : d < 7 ? labels[2] : labels[3];
    by.set(label, [...(by.get(label) ?? []), t]);
  }
  return labels.filter((l) => by.has(l)).map((l) => ({ key: l, label: l, tone: 'normal', items: by.get(l)! }));
}

/** Follow-ups grouped Overdue / Today / Tomorrow / This week / Later (done ones by when they were done). */
export function TaskList({
  scope, due, compact, limit, status = 'open', showAssignee, empty, seeAllHref, className,
}: TaskListProps) {
  const pageSize = limit ?? (compact ? 5 : 50);
  const params = { scope, due, status, limit: pageSize };
  const single = useTasks(params, { enabled: !!compact });
  const paged = useInfiniteTasks(params, { enabled: !compact });
  const q = compact ? single : paged;
  const items = compact ? single.data?.items : paged.data?.pages.flatMap((p) => p.items);
  const [logFor, setLogFor] = useState<Task | null>(null);
  const now = useNow();
  const assignee = showAssignee ?? scope === 'team';

  if (q.isLoading) return <ListSkeleton compact={compact} />;
  if (q.error && !items) {
    return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} className={compact ? 'py-6' : undefined} />;
  }
  if (!items?.length) {
    return <>{empty ?? <EmptyState compact icon={<CalendarCheck />} title="No follow-ups here" description="Log a call on a lead and schedule the next step: it will show up here." />}</>;
  }

  const groups = status === 'done' ? groupDone(items, now) : groupOpen(items, now);
  const more = compact ? !!single.data?.nextCursor : !!paged.hasNextPage;
  // One group (the Overdue or Today tab) needs no heading: the tab already says it.
  const headings = compact || groups.length > 1;

  return (
    <div className={className}>
      {groups.map((g) => (
        <section key={g.key} aria-label={`${g.label}, ${g.items.length}`}>
          {headings && <h3
            className={cn(
              'flex items-center gap-2 font-semibold tracking-wide uppercase',
              compact ? 'px-3 pt-3 pb-1 text-[11px]' : 'border-b border-divider bg-surface-2 px-4 py-2.5 text-xs sm:px-5',
              g.tone === 'overdue' ? 'text-roof' : g.tone === 'today' ? 'text-warning' : 'text-muted',
            )}
          >
            {g.label}
            <span className={cn('rounded-full px-1.5 tabular normal-case', g.tone === 'overdue' ? 'bg-roof-soft' : g.tone === 'today' ? 'bg-warning-soft' : 'bg-surface-3')}>
              {g.items.length}
            </span>
          </h3>}
          <ul className="divide-y divide-divider">
            {g.items.map((t) => (
              <TaskRow key={t.id} task={t} compact={compact} showAssignee={assignee} onLog={setLogFor} now={now} />
            ))}
          </ul>
        </section>
      ))}
      {more && (compact ? (
        <div className="border-t border-divider px-3 py-2">
          <Link to={seeAllHref ?? `/tasks?tab=${DUE_TAB[due]}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            See all follow-ups <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      ) : (
        <div className="border-t border-divider p-2.5">
          <Button variant="ghost" className="w-full" loading={paged.isFetchingNextPage} onClick={() => void paged.fetchNextPage()}>
            Show more follow-ups
          </Button>
        </div>
      ))}
      {logFor && (
        <LogActivityDialog
          leadId={logFor.companyId}
          leadName={logFor.companyName}
          defaultType={activityKindOf(logFor.type)}
          task={logFor}
          open
          onOpenChange={(open) => !open && setLogFor(null)}
        />
      )}
    </div>
  );
}

/** "Now", moved on every minute so Today and Overdue roll over at midnight on an open tab. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Rows load their contractor's phone only once they scroll near the viewport. */
function useInView<T extends Element>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);
  return [setEl, seen];
}

function TaskRow({
  task, compact, showAssignee, onLog, now,
}: { task: Task; compact?: boolean; showAssignee: boolean; onLog: (t: Task) => void; now: Date }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const complete = useCompleteTask();
  const reschedule = useRescheduleTask();
  const remove = useDeleteTask();
  const [ref, inView] = useInView<HTMLLIElement>();
  const done = !!task.doneAt;
  const phone = useLeadPhone(task.companyId, !compact && !done && inView);
  const bucket = bucketOf(task.dueAt, now);
  const tone = done ? 'normal' : bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : 'normal';
  const kind = activityKindOf(task.type);
  const typeLabel = TASK_TYPE_META[task.type]?.label ?? 'Follow-up';

  const toggle = async (next: boolean) => {
    try {
      const res = await complete.mutateAsync({ task, done: next });
      if (next) {
        toast({
          id: `task-done-${task.id}`,
          variant: 'success',
          title: 'Follow-up done',
          description: `${task.title} · ${task.companyName}`,
          action: { label: 'Undo', onClick: () => complete.mutate({ task: res.task, done: false }) },
        });
      }
    } catch (err) {
      toast.error(next ? 'Couldn’t mark it done' : 'Couldn’t reopen it', errorMessage(err));
    }
  };

  const move = async (day: string) => {
    try {
      await reschedule.mutateAsync({ task, day });
      toast.success('Follow-up moved', `${task.title}: ${formatDay(day)}`);
    } catch (err) {
      toast.error('Couldn’t reschedule it', errorMessage(err));
    }
  };

  const del = async () => {
    try {
      await remove.mutateAsync({ task });
      toast({
        id: `task-deleted-${task.id}`,
        title: 'Follow-up deleted',
        description: task.title,
        action: {
          label: 'Undo',
          onClick: () => {
            void createTask(task.companyId, {
              title: task.title, type: task.type, dueAt: salesDay(task.dueAt), assigneeId: task.assignee.id,
              ...(task.note ? { note: task.note } : {}),
            }).then(
              () => invalidateAfterTaskWrite(qc, task.companyId),
              (err: unknown) => toast.error('Couldn’t restore it', errorMessage(err)),
            );
          },
        },
      });
    } catch (err) {
      toast.error('Couldn’t delete it', errorMessage(err));
    }
  };

  const busy = complete.isPending || remove.isPending;

  return (
    <li
      ref={ref}
      className={cn(
        'flex gap-3 transition-colors',
        compact ? 'items-start px-3 py-2.5' : 'items-start px-4 py-3.5 hover:bg-hover/50 sm:items-center sm:gap-3.5 sm:px-5 sm:py-4',
        done && 'bg-surface-2/60',
      )}
    >
      <div className={cn('flex shrink-0 items-center gap-3', compact ? 'pt-px' : 'pt-1.5 sm:pt-0')}>
        <CompleteToggle
          checked={done}
          onChange={(v) => void toggle(v)}
          disabled={busy}
          size={compact ? 'sm' : 'md'}
          label={done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
        />
        {!compact && <span className="hidden sm:flex"><TaskTypeIcon type={task.type} /></span>}
      </div>

      <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-5">
        <div className="min-w-0 flex-1">
          <p className={cn('flex min-w-0 items-center gap-1.5 font-medium', compact ? 'text-sm' : 'text-[15px]', done ? 'text-muted line-through' : 'text-fg')}>
            <span className="sr-only">{typeLabel}: </span>
            <span className={cn('flex', !compact && 'sm:hidden')}><TaskTypeIcon type={task.type} size="xs" /></span>
            <span className="line-clamp-2 min-w-0 break-words sm:line-clamp-1">{task.title}</span>
          </p>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-muted">
            <Link to={`/leads/${task.companyId}`} className="truncate font-medium text-accent hover:underline">{task.companyName}</Link>
            {!compact && phone.data?.contact && <span className="hidden truncate md:inline">· {phone.data.contact}</span>}
            {showAssignee && (
              <span className="inline-flex shrink-0 items-center gap-1">
                <span aria-hidden>·</span>
                <Avatar name={task.assignee.name} size={18} />
                <span className="sr-only">Assigned to</span>
                {task.assignee.name.split(' ')[0]}
              </span>
            )}
          </p>
        </div>

        <div
          className={cn(
            'flex items-center gap-x-2 gap-y-1',
            compact ? 'mt-1 flex-wrap sm:mt-0' : 'mt-2 sm:mt-0 sm:grid sm:grid-cols-[9.5rem_8.5rem_7.5rem] sm:gap-x-4',
          )}
        >
          {!compact && (done ? <span className="hidden sm:block" /> : <PhoneCell phone={phone.data?.phone ?? null} loading={phone.isLoading} />)}
          {done ? (
            <span className="text-sm text-muted">{doneText(task.doneAt!, now)}</span>
          ) : (
            <div className="order-first -ml-1.5 mr-auto sm:order-none sm:mr-0">
              <RescheduleMenu
                task={task}
                onReschedule={(day) => void move(day)}
                trigger={(p) => (
                  <DueButton {...p} label={dueText(task.dueAt, now)} tone={tone} aria-label={`Due ${dueText(task.dueAt, now)}. Reschedule`} />
                )}
              />
            </div>
          )}
          {!done && !compact && (
            <Button size="sm" variant="secondary" leftIcon={<NotebookPen className="size-4" aria-hidden />} onClick={() => onLog(task)} aria-label={`Log ${kind} with ${task.companyName}`} className="sm:w-full">
              <span className="sm:hidden">Log</span>
              <span className="hidden sm:inline">Log {kind}</span>
            </Button>
          )}
        </div>
      </div>

      <div className={cn('flex shrink-0 items-center', compact ? '' : 'pt-0.5 sm:pt-0')}>
        {compact && !done && (
          <IconButton size="sm" label={`Log ${kind} with ${task.companyName}`} icon={<NotebookPen />} onClick={() => onLog(task)} />
        )}
        <Menu
          align="end"
          trigger={(p) => (
            <button
              type="button"
              {...p}
              aria-label={`More for “${task.title}”`}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          )}
          items={[
            { label: 'Open contractor', icon: <ExternalLink />, onSelect: () => navigate(`/leads/${task.companyId}`) },
            ...(done ? [{ label: 'Mark not done', icon: <RotateCcw />, onSelect: () => void toggle(false) }] : []),
            ...(!done && compact ? [{ label: `Log ${kind}`, icon: <NotebookPen />, onSelect: () => onLog(task) }] : []),
            { label: 'Delete follow-up', icon: <Trash2 />, danger: true, onSelect: () => void del() },
          ]}
        />
      </div>
    </li>
  );
}

/** Desktop: the number; phones: a call button that dials it. */
function PhoneCell({ phone, loading }: { phone: string | null; loading: boolean }) {
  if (loading) return <Skeleton className="h-4 w-8 sm:w-32" />;
  if (!phone) return <span className="hidden text-sm text-subtle sm:inline">No phone yet</span>;
  return (
    <a
      href={telHref(phone)}
      aria-label={`Call ${formatPhone(phone)}`}
      className={cn(
        'inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap text-fg tabular transition-colors hover:text-accent',
        'size-8 justify-center rounded-lg border border-border bg-surface shadow-sm',
        'sm:size-auto sm:justify-start sm:rounded-md sm:border-0 sm:bg-transparent sm:font-normal sm:shadow-none',
      )}
    >
      <Phone className="size-4 shrink-0 text-accent sm:size-3.5 sm:text-muted" aria-hidden />
      <span className="hidden sm:inline">{formatPhone(phone)}</span>
    </a>
  );
}

function ListSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading follow-ups" className="divide-y divide-divider">
      {Array.from({ length: compact ? 3 : 5 }, (_, i) => (
        <div key={i} className={cn('flex items-center gap-3', compact ? 'px-3 py-3' : 'px-4 py-4 sm:px-5 sm:py-4.5')}>
          <Skeleton className="size-5 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3 max-w-xs" />
            <Skeleton className="h-3 w-1/3 max-w-[10rem]" />
          </div>
          <Skeleton className="hidden h-3.5 w-20 sm:block" />
        </div>
      ))}
    </div>
  );
}
