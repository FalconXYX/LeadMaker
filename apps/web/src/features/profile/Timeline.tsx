import {
  Activity, CalendarCheck, CalendarClock, CalendarPlus, CalendarX, CheckCircle2, Flag, History, ListPlus, Mail, MapPinned, Pencil,
  Phone, RefreshCw, Settings2, StickyNote, Tag, UserCheck, UserPlus, type LucideIcon,
} from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import type { ActivityEntry, ActivityKind as WriteKind } from '@/api/types';
import { Avatar, Button, Card, ErrorState, Select, Spinner, Textarea, Tooltip, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { useProfile } from './context';
import { FEED_FILTERS, activityView, knownUsers, type ActivityKind, type FeedFilter } from './lib';
import { useActivityFeed } from './queries';
import { salesOf } from './sales';
import { Highlight } from './ui';

type Mode = 'note' | WriteKind;

const MODES: { value: Mode; label: string; icon: LucideIcon }[] = [
  { value: 'note', label: 'Note', icon: StickyNote },
  { value: 'call', label: 'Call', icon: Phone },
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'visit', label: 'Visit', icon: MapPinned },
];

const OUTCOMES: Record<WriteKind, string[]> = {
  call: ['Connected', 'Left voicemail', 'No answer', 'Call back later', 'Wrong number', 'Not interested'],
  email: ['Sent', 'Replied', 'No reply', 'Bounced'],
  visit: ['Met decision-maker', 'Dropped off samples', 'Left materials', 'No one available'],
};

const NOTE_MAX = 10_000;

export function ActivityPanel({ composerRef }: { composerRef?: Ref<HTMLTextAreaElement> }) {
  const [filterKey, setFilterKey] = useState('all');
  const filter = FEED_FILTERS.find((f) => f.key === filterKey) ?? FEED_FILTERS[0]!;
  // Desktop: the panel sticks beside the tabs and only the feed scrolls.
  return (
    <Card className="flex min-w-0 flex-col overflow-hidden lg:max-h-[calc(100vh-6rem)]">
      <section aria-labelledby="activity-heading" id="activity" className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3.5 sm:px-5 sm:py-4">
          <History className="mt-0.5 size-4 text-muted" aria-hidden />
          <div className="min-w-0">
            <h2 id="activity-heading" className="text-sm font-semibold text-fg">Activity &amp; notes</h2>
            <p className="mt-1 text-xs text-muted">Shared with everyone who can see this lead.</p>
          </div>
        </div>
        <div className="shrink-0"><Composer composerRef={composerRef} /></div>
        <div className="shrink-0"><FilterBar value={filterKey} onChange={setFilterKey} /></div>
        <div className="min-h-0 flex-1 lg:overflow-y-auto"><Feed filter={filter} /></div>
      </section>
    </Card>
  );
}

function Composer({ composerRef }: { composerRef?: Ref<HTMLTextAreaElement> }) {
  const { profile, canEdit, readOnlyReason, m } = useProfile();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('note');
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const busy = m.addNote.isPending || m.logActivity.isPending;

  const submit = () => {
    const note = text.trim();
    if (note.length > NOTE_MAX) return setError(`Notes can be up to ${NOTE_MAX.toLocaleString()} characters.`);
    const reset = () => {
      setText('');
      setOutcome('');
      setError(null);
    };
    if (mode === 'note') {
      if (!note) return setError('Write something first.');
      m.addNote.mutate(note, { onSuccess: () => { reset(); toast.success('Note added'); } });
    } else {
      const advanced = salesOf(profile).salesStage === 'new';
      m.logActivity.mutate(
        { type: mode, outcome: outcome || undefined, note: note || undefined },
        { onSuccess: () => { reset(); toast.success(`${MODES.find((x) => x.value === mode)!.label} logged`, advanced ? 'Stage moved to Contacted.' : undefined); } },
      );
    }
  };

  const onModeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = MODES.findIndex((x) => x.value === mode);
    const next = e.key === 'ArrowRight' ? (i + 1) % MODES.length : e.key === 'ArrowLeft' ? (i - 1 + MODES.length) % MODES.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setMode(MODES[next]!.value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  const placeholder = mode === 'note'
    ? 'Write a note for the team…'
    : `What happened on the ${mode}? (optional)`;

  return (
    <div className="border-b border-border p-4 sm:p-5">
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="What to log"
        onKeyDown={onModeKey}
        className="mb-3 inline-flex rounded-lg bg-surface-2 p-1"
      >
        {MODES.map((x) => (
          <button
            key={x.value}
            type="button"
            role="radio"
            aria-checked={mode === x.value}
            tabIndex={mode === x.value ? 0 : -1}
            disabled={!canEdit}
            onClick={() => {
              setMode(x.value);
              setError(null);
            }}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50',
              mode === x.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            <x.icon className="size-3.5" aria-hidden />{x.label}
          </button>
        ))}
      </div>
      {mode !== 'note' && (
        <Select
          selectSize="sm"
          aria-label="Outcome"
          className="mb-2.5"
          value={outcome}
          onValueChange={setOutcome}
          placeholder="Outcome (optional)"
          options={OUTCOMES[mode].map((o) => ({ value: o, label: o }))}
          disabled={!canEdit}
        />
      )}
      <Textarea
        id="activity-composer"
        ref={composerRef}
        rows={3}
        aria-label={mode === 'note' ? 'Note' : `Notes about the ${mode}`}
        placeholder={canEdit ? placeholder : 'View only'}
        value={text}
        disabled={!canEdit}
        invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className="resize-y"
      />
      {error && <p id={errorId} className="mt-1.5 text-xs text-danger">{error}</p>}
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <p className="text-xs text-subtle">
          {canEdit
            ? mode === 'note' ? 'Ctrl/⌘ + Enter to save' : 'Counts as contact: updates last contacted.'
            : readOnlyReason}
        </p>
        <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={!canEdit}>
          {mode === 'note' ? 'Add note' : `Log ${mode}`}
        </Button>
      </div>
    </div>
  );
}

function FilterBar({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  return (
    <div className="overflow-x-auto border-b border-border px-4 py-3 sm:px-5">
      <div role="group" aria-label="Filter activity" className="flex w-max gap-1">
        {FEED_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={value === f.key}
            onClick={() => onChange(f.key)}
            className={cn(
              'h-7 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
              value === f.key ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  note: StickyNote, call: Phone, email: Mail, visit: MapPinned, state: CheckCircle2, edit: Pencil, contact: UserPlus,
  tag: Tag, field: ListPlus, allocation: UserCheck, pipeline: RefreshCw, stage: Flag, task: CalendarClock, other: Activity,
};

const TASK_ICON: Record<string, LucideIcon> = {
  task_created: CalendarPlus, task_completed: CalendarCheck, task_updated: CalendarClock, task_deleted: CalendarX,
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return formatDate(iso);
}

function Feed({ filter }: { filter: FeedFilter }) {
  const { profile } = useProfile();
  const feed = useActivityFeed(profile, filter);
  const users = knownUsers(profile);
  const contacts = new Map(profile.contacts.map((c) => [c.id, c.name.value]));
  const ctx = { contactName: (id: string) => contacts.get(id) ?? null, userName: (id: string) => users.get(id) ?? null };

  if (feed.isLoading) {
    return <div className="flex justify-center p-8 text-muted"><Spinner label="Loading activity" /></div>;
  }
  if (feed.isError && feed.items.length === 0) {
    return <ErrorState message="Activity could not be loaded." onRetry={feed.retry} />;
  }
  if (feed.items.length === 0) {
    return (
      <div className="px-5 py-12 text-center">
        <p className="text-sm font-medium text-fg">{filter.key === 'all' ? 'No activity yet' : `No ${filter.label.toLowerCase()} yet`}</p>
        <p className="mt-1 text-xs text-muted">
          {filter.key === 'notes' ? 'Notes are visible to everyone who can see this lead.'
            : filter.key === 'followups' ? 'Follow-ups you add, finish or move show up here.'
            : 'Calls, notes, follow-ups and stage changes show up here.'}
        </p>
        {feed.hasMore && <LoadOlder feed={feed} />}
      </div>
    );
  }

  const groups: { day: string; items: ActivityEntry[] }[] = [];
  for (const e of feed.items) {
    const day = dayLabel(e.createdAt);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }

  return (
    <div className="px-4 pt-4 pb-5 sm:px-5">
      <div>
        {groups.map((g, i) => (
          <section key={`${g.day}-${i}`} aria-label={g.day} className="mb-1.5">
            <h3 className="sticky top-0 z-[1] -mx-1 mb-2.5 bg-surface px-1 py-1 text-xs font-semibold text-muted">{g.day}</h3>
            <ol className="relative">
              {g.items.map((e, i) => <FeedItem key={e.id} entry={e} last={i === g.items.length - 1} ctx={ctx} />)}
            </ol>
          </section>
        ))}
      </div>
      {feed.hasMore && <LoadOlder feed={feed} />}
    </div>
  );
}

function LoadOlder({ feed }: { feed: ReturnType<typeof useActivityFeed> }) {
  return (
    <div className="mt-2.5 flex justify-center">
      <Button size="sm" variant="secondary" onClick={feed.loadMore} loading={feed.isLoadingMore}>Load older activity</Button>
    </div>
  );
}

function FeedItem({ entry, last, ctx }: { entry: ActivityEntry; last: boolean; ctx: Parameters<typeof activityView>[1] }) {
  const v = activityView(entry, ctx);
  const Icon = TASK_ICON[entry.type] ?? KIND_ICON[v.kind];
  const isUser = !!entry.user;
  return (
    <Highlight as="li" k={`activity:${entry.id}`} className="relative -mx-2 flex gap-3 rounded-lg px-2 pb-5" data-testid="activity-item" data-type={entry.type}>
      {!last && <span className="absolute top-9 bottom-1 left-[23px] w-px bg-border" aria-hidden="true" />}
      {/* self-start: the row stretches with its body, the avatar (and its kind badge) must not. */}
      <div className="relative size-8 shrink-0 self-start">
        {isUser ? (
          <Avatar name={v.actor} size={32} />
        ) : (
          <span className={cn('flex size-8 items-center justify-center rounded-full', entry.actorType === 'pipeline' ? 'bg-info-soft text-info' : 'bg-surface-3 text-muted')} aria-hidden="true">
            {entry.actorType === 'pipeline' ? <RefreshCw className="size-4" /> : <Settings2 className="size-4" />}
          </span>
        )}
        {isUser && (
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-surface bg-surface-2 text-muted" aria-hidden="true">
            <Icon className="size-2.5" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm leading-5 text-fg">
          <span className="font-semibold">{v.actor}</span> <span className="text-muted">{v.action}</span>
          {' '}
          <Tooltip content={formatDateTime(entry.createdAt)} describe={false}>
            <time dateTime={entry.createdAt} className="text-xs whitespace-nowrap text-subtle">
              · {formatRelative(entry.createdAt)}
            </time>
          </Tooltip>
        </p>
        {v.outcome && <p className="mt-1 text-xs font-medium text-muted">{v.outcome}</p>}
        {v.body && (
          <p className={cn('mt-2 text-sm break-words whitespace-pre-wrap text-fg', ['note', 'call', 'email', 'visit', 'task'].includes(v.kind) ? 'rounded-lg bg-surface-2 px-3.5 py-2.5' : 'text-muted')}>
            {v.body}
          </p>
        )}
        {v.diffs.length > 0 && (
          <dl className="mt-2 space-y-1.5 rounded-lg border border-border px-3.5 py-2.5 text-xs">
            {v.diffs.map((d, i) => (
              <div key={`${d.field}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5">
                <dt className="font-medium text-muted">{d.label}:</dt>
                <dd className="min-w-0 break-words">
                  {d.from === '—'
                    ? <span className="text-subtle italic">empty</span>
                    : <span className="text-subtle line-through decoration-subtle/60">{d.from}</span>}
                  <span className="mx-1 text-subtle" aria-hidden="true">→</span>
                  <span className="sr-only"> changed to </span>
                  {d.to === '—' ? <span className="text-subtle italic">empty</span> : <span className="font-medium text-fg">{d.to}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Highlight>
  );
}
