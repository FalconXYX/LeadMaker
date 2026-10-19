import {
  CalendarClock, CalendarPlus, ChevronRight, ListChecks, Mail, MapPinned, MoreHorizontal, Phone, SquareCheck, Trash2, type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Avatar, Button, Checkbox, Menu, useToast } from '@/components/ui';
import { TaskQuickAdd } from '@/features/tasks';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useProfile } from './context';
import {
  RESCHEDULE_PRESETS, TASK_TYPE_LABELS, doneTasks, dueState, dueText, onDay, openTasks, rescheduleDate, salesOf, toDayInput,
  type DueState, type Task, type TaskType,
} from './sales';
import { ReadOnlyHint, SectionCard } from './ui';

const TYPE_ICON: Record<TaskType, LucideIcon> = { call: Phone, email: Mail, visit: MapPinned, todo: SquareCheck };

const DUE_TONE: Record<DueState, string> = {
  overdue: 'text-roof font-medium',
  today: 'text-warning font-medium',
  soon: 'text-fg',
  later: 'text-muted',
  done: 'text-subtle',
};

/** Follow-ups on this lead: open ones by due date (overdue in red), quick add, done ones folded away. */
export function NextStepsCard({ adding, onAddingChange }: { adding: boolean; onAddingChange: (open: boolean) => void }) {
  const { profile, canEdit, readOnlyReason } = useProfile();
  const { tasks } = salesOf(profile);
  const open = openTasks(tasks);
  const done = doneTasks(tasks);
  const name = profile.fields.business_name.value ?? 'this lead';
  const overdue = open.filter((t) => dueState(t) === 'overdue').length;

  const addButton = (
    <ReadOnlyHint reason={canEdit ? null : readOnlyReason}>
      <Button size="sm" variant="ghost" leftIcon={<CalendarPlus className="size-3.5" />} onClick={() => onAddingChange(true)} disabled={!canEdit || adding} aria-label="Add follow-up">
        Add
      </Button>
    </ReadOnlyHint>
  );

  return (
    <SectionCard
      id="next-steps"
      title="Next steps"
      icon={<ListChecks />}
      description={open.length ? `${open.length} open${overdue ? `, ${overdue} overdue` : ''}` : undefined}
      actions={addButton}
      highlightKey="tasks"
      bodyClassName="p-0"
    >
      {open.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Open follow-ups">
          {open.map((t) => <TaskRow key={t.id} task={t} />)}
        </ul>
      )}
      {open.length === 0 && !adding && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5 sm:py-5">
          <p className="text-sm text-muted">
            Nothing scheduled{done.length ? ' since the last one was done' : ''}. A lead with a date on it gets called back.
          </p>
          {canEdit && (
            <Button size="sm" variant="primary" leftIcon={<CalendarPlus className="size-3.5" />} onClick={() => onAddingChange(true)}>
              Schedule one
            </Button>
          )}
        </div>
      )}
      {adding && (
        <div className={cn('bg-surface-2/60 px-4 py-3.5 sm:px-5 sm:py-4', open.length > 0 && 'border-t border-border')}>
          <TaskQuickAdd leadId={profile.id} leadName={name} onDone={() => onAddingChange(false)} />
          <div className="mt-2.5 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => onAddingChange(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {done.length > 0 && <DoneTasks tasks={done} />}
    </SectionCard>
  );
}

function TaskRow({ task }: { task: Task }) {
  const { canEdit, m, meId } = useProfile();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const state = dueState(task);
  const Icon = TYPE_ICON[task.type] ?? SquareCheck;
  const busy = m.setTaskDone.isPending && m.setTaskDone.variables?.task.id === task.id;

  const complete = () =>
    m.setTaskDone.mutate({ task, done: true }, {
      onSuccess: (res) => toast({
        title: 'Follow-up done',
        description: task.title,
        variant: 'success',
        action: { label: 'Undo', onClick: () => m.setTaskDone.mutate({ task: res.task, done: false }) },
      }),
    });
  const moveTo = (dueAt: string | null) => {
    setPicking(false);
    if (dueAt && dueAt !== task.dueAt) m.rescheduleTask.mutate({ task, dueAt });
  };

  return (
    <li className={cn('flex gap-3 px-4 py-3.5 sm:px-5', state === 'overdue' && 'bg-roof-soft/50')} data-testid="task-row">
      <Checkbox
        checked={false}
        onChange={complete}
        label={`Mark “${task.title}” done`}
        disabled={!canEdit || busy}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words text-fg">{task.title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <Icon className="size-3.5" aria-hidden />{TASK_TYPE_LABELS[task.type] ?? 'To-do'}
          </span>
          <span aria-hidden="true">·</span>
          <span className={DUE_TONE[state]}>{dueText(task)}</span>
          {task.assignee.id !== meId && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1"><Avatar name={task.assignee.name} size={16} />{task.assignee.name}</span>
            </>
          )}
        </p>
        {task.note && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{task.note}</p>}
        {picking && (
          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="date"
              aria-label={`New date for “${task.title}”`}
              defaultValue={toDayInput(task.dueAt)}
              autoFocus
              onChange={(e) => moveTo(onDay(e.target.value, task.dueAt))}
              className="h-8 rounded-lg border border-border bg-surface px-2 text-sm text-fg focus:border-focus focus:ring-2 focus:ring-focus/40 focus:outline-none"
            />
            <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>Cancel</Button>
          </div>
        )}
      </div>
      {canEdit && (
        <Menu
          align="end"
          trigger={(p) => (
            <button
              {...p}
              type="button"
              aria-label={`Reschedule or remove “${task.title}”`}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          )}
          header={<p className="text-xs font-semibold text-muted">Move to</p>}
          items={[
            ...RESCHEDULE_PRESETS.map((r) => ({
              label: r.label,
              icon: <CalendarClock />,
              onSelect: () => moveTo(rescheduleDate(r.value, task.dueAt)),
            })),
            { label: 'Pick a date…', icon: <CalendarPlus />, onSelect: () => setPicking(true) },
            { label: 'Remove follow-up', icon: <Trash2 />, danger: true, onSelect: () => m.deleteTask.mutate(task) },
          ]}
        />
      )}
    </li>
  );
}

function DoneTasks({ tasks }: { tasks: Task[] }) {
  const { canEdit, m } = useProfile();
  return (
    <details className="group border-t border-border">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-3 text-xs font-medium text-muted hover:text-fg sm:px-5 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        Done ({tasks.length})
      </summary>
      <ul className="space-y-2.5 px-4 pb-4 sm:px-5">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-3 text-sm">
            <Checkbox
              checked
              onChange={() => m.setTaskDone.mutate({ task: t, done: false })}
              label={`Reopen “${t.title}”`}
              disabled={!canEdit}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <p className="break-words text-muted line-through decoration-subtle">{t.title}</p>
              <p className="text-xs text-subtle">Done {formatRelative(t.doneAt)}</p>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
