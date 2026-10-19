// Selection bar (floating at the bottom) with change stage, add follow-up, add tag and allocate, and the dialogs
// for a bulk follow-up and a bulk tag.
import { CalendarPlus, ChevronDown, Kanban, Plus, Settings2, Shuffle, Tag, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { CustomTagListItem } from '@/api/types';
import { Button, CustomTagBadge, Dialog, Input, Segmented, Textarea, Tooltip, buttonClasses } from '@/components/ui';
import { cn } from '@/lib/cn';
import { pluralize } from '@/lib/format';
import type { TaskCreate } from '../api';
import { TASK_TYPES, TASK_TYPE_LABELS, type SalesStage, type TaskType } from '../sales';
import { FloatingMenu, useMenuAnchor } from './FloatingMenu';
import { StageMenuItems } from './stage';

export function BulkBar({
  count, writable, isManager, onStage, onFollowUp, onTag, onAllocate, onClear, busy, className, compact,
}: {
  compact?: boolean;
  count: number;
  writable: number;
  isManager: boolean;
  onStage: (stage: SalesStage) => void;
  onFollowUp: () => void;
  onTag: () => void;
  onAllocate: () => void;
  onClear: () => void;
  busy?: boolean;
  className?: string;
}) {
  const stageMenu = useMenuAnchor();
  if (count === 0) return null;
  const readOnly = count - writable;
  const noWrite = isManager ? 'None of these leads can be changed' : 'You can change only leads allocated to you';
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className={cn(
        // Phones: clear of the assistant button on the right. Wider screens: centred over the list.
        'fixed right-[76px] bottom-20 left-3 z-40 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface px-3 py-2 shadow-lg animate-[lm-pop-in_140ms_ease-out]',
        'md:right-auto md:bottom-6 md:left-1/2 md:w-[min(780px,calc(100vw-6rem))] md:-translate-x-1/2',
        className,
      )}
    >
      <div className="min-w-0 flex-1 pl-1">
        <p className="text-sm font-semibold text-fg tabular">{pluralize(count, 'lead')} selected</p>
        {readOnly > 0 && (
          <p className="truncate text-xs text-muted">
            {writable === 0 ? 'View only: unallocated or another rep’s' : `${readOnly} read-only (changes will skip them)`}
          </p>
        )}
      </div>
      <div className={cn('flex items-center gap-1.5 overflow-x-auto', compact ? 'order-last w-full pb-0.5' : 'shrink-0')}>
        {writable > 0 ? (
          <>
            <button
              ref={stageMenu.setAnchor}
              type="button"
              aria-haspopup="menu"
              aria-expanded={stageMenu.open}
              disabled={busy}
              onClick={() => stageMenu.setOpen(!stageMenu.open)}
              className={buttonClasses('secondary', 'sm', 'h-8')}
            >
              <Kanban className="size-3.5" aria-hidden />{compact ? 'Stage' : 'Change stage'}<ChevronDown className="size-3.5 text-subtle" aria-hidden />
            </button>
            <FloatingMenu anchor={stageMenu.anchor} open={stageMenu.open} onClose={stageMenu.close} label="Move the selected leads to" align="end">
              <p className="px-3 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">Move {pluralize(writable, 'lead')} to</p>
              <StageMenuItems value={null} onPick={(s) => { stageMenu.close(true); onStage(s); }} />
            </FloatingMenu>
          </>
        ) : <Disabled reason={noWrite} icon={<Kanban className="size-3.5" />}>{compact ? 'Stage' : 'Change stage'}</Disabled>}
        {writable > 0 ? (
          <Button size="sm" variant="secondary" leftIcon={<CalendarPlus className="size-3.5" />} onClick={onFollowUp} className="h-8" disabled={busy}>
            {compact ? 'Follow-up' : 'Add follow-up'}
          </Button>
        ) : <Disabled reason={noWrite} icon={<CalendarPlus className="size-3.5" />}>{compact ? 'Follow-up' : 'Add follow-up'}</Disabled>}
        {writable > 0 ? (
          <Button size="sm" variant="secondary" leftIcon={<Tag className="size-3.5" />} onClick={onTag} className="h-8">
            {compact ? 'Tag' : 'Add tag'}
          </Button>
        ) : <Disabled reason={isManager ? 'None of these leads can be tagged' : 'You can tag only leads allocated to you'} icon={<Tag className="size-3.5" />}>{compact ? 'Tag' : 'Add tag'}</Disabled>}
        {isManager && (
          <Button size="sm" variant="primary" leftIcon={<Shuffle className="size-3.5" />} onClick={onAllocate} className="h-8">
            {compact ? 'Allocate' : 'Allocate selected…'}
          </Button>
        )}
      </div>
      <Tooltip content="Clear selection (Esc)" describe={false}>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-4" aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

function Disabled({ reason, icon, children }: { reason: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} className="rounded-lg">
        <Button size="sm" variant="secondary" leftIcon={icon} disabled className="h-8">{children}</Button>
      </span>
    </Tooltip>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Next working day, as the date field's default. */
function nextWorkday(now = new Date()): string {
  const d = new Date(now);
  do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  return dateInput(d);
}

/** A follow-up (what, when, a note) for one lead, or one each for the writable selected leads. */
export function FollowUpDialog({
  open, onClose, leadName, writable, readOnly, busy, isManager, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  /** One lead: its name heads the dialog. */
  leadName?: string;
  writable: number;
  readOnly: number;
  busy: boolean;
  isManager: boolean;
  onSubmit: (task: Omit<TaskCreate, 'assigneeId'>) => void;
}) {
  const [type, setType] = useState<TaskType>('call');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(nextWorkday);
  const [note, setNote] = useState('');
  const fallback = `${TASK_TYPE_LABELS[type]} follow-up`;
  const close = () => {
    setTitle('');
    setNote('');
    setDue(nextWorkday());
    onClose();
  };
  const submit = () => {
    if (!due || writable === 0) return;
    // 9am local on the chosen day.
    const [y, m, d] = due.split('-').map(Number);
    const dueAt = new Date(y!, m! - 1, d!, 9).toISOString();
    onSubmit({ title: title.trim() || fallback, type, dueAt, ...(note.trim() ? { note: note.trim() } : {}) });
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add follow-up"
      description={leadName
        ? `${leadName}${isManager ? ' · for the lead’s rep, or you when it is unallocated' : ''}`
        : `For ${pluralize(writable, 'lead')}${readOnly ? ` (${readOnly} read-only skipped)` : ''}.${isManager ? ' Each goes to the lead’s rep, or to you when it is unallocated.' : ''}`}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!due || writable === 0} onClick={submit}>{leadName ? 'Add follow-up' : 'Add follow-ups'}</Button>
        </>
      )}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Type</span>
          <Segmented label="Follow-up type" size="sm" fullWidth value={type} onChange={setType} options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="bulk-task-title" className="text-xs font-medium text-muted">What</label>
          <Input id="bulk-task-title" data-autofocus value={title} maxLength={200} placeholder={fallback} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="bulk-task-due" className="text-xs font-medium text-muted">Due</label>
          <Input id="bulk-task-due" type="date" value={due} min={dateInput(new Date())} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="bulk-task-note" className="text-xs font-medium text-muted">Note <span className="font-normal text-subtle">(optional)</span></label>
          <Textarea id="bulk-task-note" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </div>
      </form>
    </Dialog>
  );
}

export function AddTagDialog({
  open, onClose, tags, writable, readOnly, busy, onSubmit, onManageTags, maxPerRequest,
}: {
  open: boolean;
  onClose: () => void;
  tags: readonly CustomTagListItem[];
  writable: number;
  readOnly: number;
  busy: boolean;
  onSubmit: (tag: { id: string; name: string } | { name: string }) => void;
  /** Opens Manage tags (rename / delete) in place of this dialog. */
  onManageTags?: () => void;
  /** GET /api/config maxBulkTag: larger selections go in several requests. */
  maxPerRequest?: number;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const q = query.trim();
  const matches = useMemo(
    () => tags.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8),
    [tags, q],
  );
  const exact = tags.find((t) => t.name.toLowerCase() === q.toLowerCase());
  const target = picked ?? (exact ? { id: exact.id, name: exact.name } : q ? { name: q } : null);

  const close = () => {
    setQuery('');
    setPicked(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add tag"
      description={writable > 0
        ? `Tag ${pluralize(writable, 'lead')}${readOnly ? ` (${readOnly} read-only ${readOnly === 1 ? 'lead' : 'leads'} will be skipped)` : ''}.`
        : 'None of the selected leads can be edited by you.'}
      size="sm"
      footer={(
        <>
          {onManageTags && tags.length > 0 && (
            <button
              type="button"
              onClick={() => {
                close();
                onManageTags();
              }}
              className="mr-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
            >
              <Settings2 className="size-3.5" aria-hidden />Manage tags…
            </button>
          )}
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!target || writable === 0 || q.length > 100}
            onClick={() => target && onSubmit(target)}
          >
            {target && !('id' in target) ? 'Create & add' : 'Add tag'}
          </Button>
        </>
      )}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (target && writable > 0) onSubmit(target);
        }}
      >
        <label htmlFor="bulk-tag-name" className="mb-1.5 block text-xs font-medium text-muted">Tag</label>
        <Input
          id="bulk-tag-name"
          data-autofocus
          value={picked ? picked.name : query}
          maxLength={100}
          placeholder="Find or create a tag…"
          autoComplete="off"
          onChange={(e) => {
            setPicked(null);
            setQuery(e.target.value);
          }}
        />
        {!picked && (
          <div className="mt-3">
            {matches.length > 0 && (
              <>
                <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">{q ? 'Matching tags' : 'Existing tags'}</p>
                <div className="flex flex-wrap gap-1.5">
                  {matches.map((t) => (
                    <button key={t.id} type="button" onClick={() => setPicked({ id: t.id, name: t.name })} className="rounded-full focus-visible:ring-2 focus-visible:ring-focus/50">
                      <CustomTagBadge name={`${t.name} · ${t.leadCount}`} className="cursor-pointer hover:brightness-95" />
                    </button>
                  ))}
                </div>
              </>
            )}
            {q && !exact && (
              <p className="mt-3 flex gap-1.5 text-xs text-muted">
                <Plus className="mt-px size-3.5 shrink-0 text-accent" aria-hidden />
                <span>Creates a new tag <span className="font-medium break-words text-fg">“{q}”</span> your team can filter by.</span>
              </p>
            )}
            {!q && matches.length === 0 && <p className="text-xs text-muted">No tags yet. Type a name to create the first one.</p>}
          </div>
        )}
        {maxPerRequest !== undefined && writable > maxPerRequest && (
          <p className="mt-3 text-xs text-muted">
            Tags {pluralize(writable, 'lead')} in {Math.ceil(writable / maxPerRequest)} batches of up to {maxPerRequest.toLocaleString()}.
          </p>
        )}
        {picked && (
          <p className="mt-2 text-xs text-muted">
            Adds the existing tag <span className="font-medium text-fg">“{picked.name}”</span>.{' '}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => setPicked(null)}>Change</button>
          </p>
        )}
      </form>
    </Dialog>
  );
}
