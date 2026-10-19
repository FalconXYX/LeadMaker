import { Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { ForbiddenError, errorMessage } from '@/api/errors';
import { useLead, useUsers } from '@/api/queries';
import { useAuth } from '@/auth/AuthContext';
import { Button, Input, Segmented, Select, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { TaskType } from './api';
import { dayOfChoice, dueError, formatDay, type DueChoice } from './dates';
import { TASK_TYPES, TASK_TYPE_META } from './model';
import { DuePicker } from './parts';
import { useCreateTask } from './queries';

export interface TaskQuickAddProps {
  leadId: string;
  leadName?: string;
  onDone?: () => void;
  className?: string;
  /** Focus the title on mount (default: it is usually opened by a click). */
  autoFocus?: boolean;
}

const DEFAULT_TITLES: Record<TaskType, string> = {
  call: 'Follow-up call',
  email: 'Send a follow-up email',
  visit: 'Stop by in person',
  todo: 'Follow up',
};

/** Inline "add a follow-up" form: type, title, when, and (managers) who. Enter saves. */
export function TaskQuickAdd({ leadId, leadName, onDone, className, autoFocus = true }: TaskQuickAddProps) {
  const { user, isManager } = useAuth();
  const toast = useToast();
  const create = useCreateTask();
  const whenId = useId();
  const [type, setType] = useState<TaskType>('call');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState<DueChoice>({ preset: 'tomorrow' });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const users = useUsers(undefined, { enabled: isManager });
  const lead = useLead(isManager ? leadId : undefined);
  const owner = lead.data?.allocation?.current?.rep ?? null;
  const [assignee, setAssignee] = useState<string>('');
  const assigneeId = assignee || owner?.id || user?.id || '';
  const people = [
    ...(user ? [{ value: user.id, label: `Me (${user.name})` }] : []),
    ...(users.data?.items ?? []).filter((u) => u.id !== user?.id).map((u) => ({ value: u.id, label: u.role === 'manager' ? `${u.name} (manager)` : u.name })),
  ];
  if (owner && !people.some((p) => p.value === owner.id)) people.push({ value: owner.id, label: owner.name });

  // The calendar's day loads are whoever the follow-up is for: a manager assigning a rep sees that rep's days.
  const forSomeoneElse = isManager && !!assigneeId && assigneeId !== user?.id;
  const assigneeName = forSomeoneElse
    ? (users.data?.items ?? []).find((u) => u.id === assigneeId)?.name ?? (owner?.id === assigneeId ? owner.name : undefined)
    : undefined;

  const effectiveTitle = title.trim() || DEFAULT_TITLES[type];
  const dueProblem = dueError(due);

  const submit = async () => {
    setSubmitted(true);
    const day = dayOfChoice(due);
    if (dueProblem || !day || create.isPending) return;
    setError(null);
    try {
      await create.mutateAsync({
        leadId, title: effectiveTitle, type, day,
        ...(isManager && assigneeId && assigneeId !== user?.id ? { assigneeId } : {}),
      });
      const who = isManager && assigneeId !== user?.id ? people.find((p) => p.value === assigneeId)?.label : null;
      toast.success('Follow-up added', `${effectiveTitle}, ${formatDay(day)}${who ? ` for ${who}` : ''}${leadName ? ` · ${leadName}` : ''}`);
      setTitle('');
      setSubmitted(false);
      onDone?.();
    } catch (err) {
      setError(err instanceof ForbiddenError ? 'You can only add follow-ups on your own leads.' : errorMessage(err));
    }
  };

  return (
    <form
      noValidate
      aria-label={leadName ? `Add a follow-up for ${leadName}` : 'Add a follow-up'}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className={cn('flex flex-col gap-3', className)}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <Segmented
          label="Follow-up type"
          value={type}
          onChange={setType}
          options={TASK_TYPES.map((t) => {
            const Icon = TASK_TYPE_META[t].icon;
            return { value: t, label: <Icon aria-hidden />, ariaLabel: TASK_TYPE_META[t].label };
          })}
        />
        <Input
          aria-label="Follow-up title"
          data-autofocus={autoFocus ? '' : undefined}
          autoFocus={autoFocus}
          value={title}
          maxLength={200}
          placeholder={DEFAULT_TITLES[type]}
          onChange={(e) => setTitle(e.target.value)}
          className="min-w-0 flex-1"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span id={whenId} className="text-xs font-medium text-muted">When</span>
        <DuePicker
          labelledBy={whenId}
          value={due}
          onChange={setDue}
          error={submitted ? dueProblem : null}
          loadScope={forSomeoneElse ? `rep:${assigneeId}` : 'mine'}
          loadWho={assigneeName?.split(' ')[0]}
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {isManager && people.length > 1 && (
          <label className="mr-auto flex items-center gap-2 text-xs font-medium text-muted">
            For
            <Select aria-label="Assign to" selectSize="sm" value={assigneeId} onValueChange={setAssignee} options={people} className="min-w-44" />
          </label>
        )}
        <Button type="submit" variant="primary" size="sm" leftIcon={<Plus className="size-4" aria-hidden />} loading={create.isPending}>
          Add follow-up
        </Button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
    </form>
  );
}
