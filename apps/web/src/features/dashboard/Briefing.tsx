// Today's calls: the call list under the "Today" heading (beside Follow-ups on desktop). It opens on the top three
// leads; "Show N more" opens the rest in place. Each row says why to call and, when the lead has one, the AI pitch.
import { ArrowRight, CalendarClock, CheckCircle2, ChevronDown, CloudLightning, NotebookPen, Phone, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { VersionConflictError } from '@/api/errors';
import type { LeadProfile } from '@/api/types';
import { Button, EmptyState, Menu, Skeleton, Tooltip, buttonClasses, useToast } from '@/components/ui';
import { LogActivityDialog } from '@/features/tasks';
import { cn } from '@/lib/cn';
import { readableWeatherText } from '@/lib/labels';
import type { DashboardScope } from './api';
import {
  bestContact, cityOf, countKinds, formatPhone, stageOf, toTel, weatherChip, type BriefingKind, type BriefingRow,
} from './callList';
import { firstSentence } from './ai';
import { CardError, MoreLink, Section, StagePill } from './parts';
import { useLeadDetails, useRefreshAfterActivity, useRescheduleTask, useScheduleFollowUp } from './queries';
import { salesLeadsHref } from './sales';

/** Rows shown at first; "Show more" opens up to MAX_ROWS (each row reads its lead's profile for the contact). */
export const COLLAPSED_ROWS = 3;
export const MAX_ROWS = 24;

/**
 * The row layout follows the card's width (it sits in a column on desktop): stacked when narrow; from 40rem the
 * contractor and the reason to call sit side by side, with who to ask for and the actions under them.
 */
const ROW_GRID = '@min-[40rem]:grid-cols-[minmax(0,1fr)_minmax(21.5rem,0.8fr)] @min-[40rem]:items-center';

const KIND_MARK: Record<BriefingKind, string> = {
  overdue: 'bg-roof',
  today: 'bg-accent',
  quote: 'bg-warning',
  interested: 'bg-stage-interested-fill',
  new: 'bg-stage-new-fill',
  strategic: 'bg-seg-strategic',
};

const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** 9 AM local, `days` from today; "next week" lands on Monday. */
export function followUpDate(choice: 'tomorrow' | 'in3' | 'nextWeek', now = Date.now()): Date {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (choice === 'tomorrow') d.setDate(d.getDate() + 1);
  else if (choice === 'in3') d.setDate(d.getDate() + 3);
  else d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return d;
}

const CHOICES = [
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'in3', label: 'In 3 days' },
  { key: 'nextWeek', label: 'Next Monday' },
] as const;

export interface BriefingProps {
  scope: DashboardScope;
  rows: readonly BriefingRow[];
  isLoading: boolean;
  isFetchingMore: boolean;
  error: unknown;
  partialError: boolean;
  onRetry: () => void;
  /** Team view: show whose lead each row is. */
  showOwner: boolean;
  /** SalesDashboard.callPitches: the AI pitch per lead id (else the lead profile's insight is used). */
  pitches?: Readonly<Record<string, string>>;
  /** Controlled "Show more" (the page lines up the column beside it only while collapsed). */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

export function Briefing({
  scope, rows, isLoading, isFetchingMore, error, partialError, onRetry, showOwner, pitches, expanded: expandedProp, onExpandedChange, className,
}: BriefingProps) {
  const [expandedState, setExpandedState] = useState(false);
  const expanded = expandedProp ?? expandedState;
  const setExpanded = (next: boolean) => { setExpandedState(next); onExpandedChange?.(next); };
  const [logFor, setLogFor] = useState<Pick<BriefingRow, 'leadId' | 'leadName' | 'task'> | null>(null);
  const refresh = useRefreshAfterActivity();
  const listId = useId();
  const visible = rows.slice(0, expanded ? MAX_ROWS : COLLAPSED_ROWS);
  const more = Math.min(rows.length, MAX_ROWS) - COLLAPSED_ROWS;
  const details = useLeadDetails(visible.map((r) => r.leadId));
  const kinds = countKinds(rows);
  const followUps = kinds.overdue + kinds.today;

  const summary = isLoading ? 'Pulling together your calls…'
    : !rows.length ? null
    : [
      `${rows.length} ${rows.length === 1 ? 'lead' : 'leads'} to work`,
      followUps ? `${followUps} follow-up${followUps === 1 ? '' : 's'} due` : null,
      kinds.quote + kinds.interested ? `${kinds.quote + kinds.interested} warm deal${kinds.quote + kinds.interested === 1 ? '' : 's'} to chase` : null,
    ].filter(Boolean).join(' · ');

  return (
    <Section
      id="briefing"
      title="Today’s calls"
      description={summary}
      className={className}
      accent="roof"
      level={3}
      bodyClassName="@container px-0 pb-2"
      action={<MoreLink to="/tasks">All follow-ups</MoreLink>}
    >
      {isLoading ? (
        <BriefingSkeleton />
      ) : error && !rows.length ? (
        <CardError error={error} onRetry={onRetry} />
      ) : !rows.length ? (
        <EmptyState
          compact
          icon={<CheckCircle2 />}
          title="You’re all caught up"
          description="No follow-ups due and no warm leads waiting on you. A good time to open a few strategic leads and book first calls."
          action={(
            <Link to={salesLeadsHref(scope, { stages: ['new'], segment: ['strategic'] })} className={buttonClasses('primary', 'md')}>
              Find leads to call
            </Link>
          )}
        />
      ) : (
        <>
          <ol id={listId} aria-label="Today’s call list" className="divide-y divide-border">
            {visible.map((row) => (
              <BriefingItem
                key={row.key}
                row={pitches?.[row.leadId] ? { ...row, aiPitch: pitches[row.leadId] } : row}
                profile={details.get(row.leadId)?.data}
                profileLoading={!!details.get(row.leadId)?.isLoading}
                showOwner={showOwner}
                onLog={() => setLogFor({ leadId: row.leadId, leadName: row.leadName, task: row.task })}
              />
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-border px-4 pt-3.5 pb-1 text-sm">
            <span className="text-muted">
              {isFetchingMore ? 'Checking for more leads to work…'
                : partialError ? <>Some suggestions couldn’t load. <button type="button" className="font-medium text-accent hover:underline" onClick={onRetry}>Try again</button></>
                : 'Overdue follow-ups first, then today’s, then warm deals and new leads.'}
            </span>
            {more > 0 && (
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {expanded && rows.length > MAX_ROWS && <MoreLink to="/tasks">See every follow-up</MoreLink>}
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setExpanded(!expanded)}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md text-sm font-medium text-accent hover:underline"
                >
                  {expanded ? 'Show less' : `Show ${more} more`}
                  <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden />
                </button>
              </span>
            )}
          </div>
        </>
      )}
      {logFor && (
        <LogActivityDialog
          leadId={logFor.leadId}
          leadName={logFor.leadName}
          defaultType="call"
          open
          task={logFor.task ?? undefined}
          onOpenChange={(open) => { if (!open) setLogFor(null); }}
          onDone={() => refresh(logFor.leadId)}
        />
      )}
    </Section>
  );
}

function BriefingItem({
  row, profile, profileLoading, showOwner, onLog,
}: { row: BriefingRow; profile: LeadProfile | undefined; profileLoading: boolean; showOwner: boolean; onLog: () => void }) {
  const contact = bestContact(profile, row.lead);
  const stage = stageOf(profile, row.lead);
  const city = cityOf(profile, row.lead);
  const weather = weatherChip(profile, row.lead);
  const owner = row.task?.assignee?.name ?? row.lead?.assignedRep?.name ?? profile?.allocation.current?.rep.name ?? null;
  const factsLoading = profileLoading && !row.lead;
  const pitch = row.aiPitch ?? firstSentence(profile?.insights?.salesRecommendation);

  return (
    <li className={cn('relative grid grid-cols-1 gap-x-4 gap-y-2.5 px-4 py-4 sm:py-4.5', ROW_GRID)}>
      <span className={cn('absolute top-4 bottom-4 left-0 w-1 rounded-r sm:top-4.5 sm:bottom-4.5', KIND_MARK[row.kind])} aria-hidden />
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 @min-[40rem]:flex-1">
          <Link to={`/leads/${row.leadId}`} title={row.leadName} className="block truncate text-[15px] font-semibold text-fg hover:text-accent hover:underline">
            {row.leadName}
          </Link>
          {factsLoading ? <Skeleton className="mt-1 h-3 w-24" /> : (
            <div className="flex min-w-0 items-center justify-between gap-3">
              <p className="min-w-0 truncate text-sm text-muted" title={[city ?? 'Location unknown', showOwner ? owner : null].filter(Boolean).join(' · ')}>
                {city ?? 'Location unknown'}
                {showOwner && owner && <> · {owner}</>}
              </p>
              {/* Two-column rows: the stage sits on the city line, so the name gets the column's full width. */}
              <StagePill stage={stage} className="@max-[40rem]:hidden" />
            </div>
          )}
        </div>
        <StagePill stage={stage} className="@min-[40rem]:hidden" />
      </div>
      <div className="min-w-0">
        <p className={cn('text-sm font-medium', row.kind === 'overdue' ? 'text-roof' : 'text-fg')}><span className="sr-only">Reason to call: </span>{row.why}</p>
        {(row.detail || weather) && (
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            {row.detail && <span className="min-w-0 truncate" title={row.detail}>{row.detail}</span>}
            {weather && (
              <Tooltip content={readableWeatherText(weather.reason)}>
                <span className="inline-flex h-5 max-w-full items-center gap-1 rounded-full bg-timing-medium-soft px-2.5 text-[11px] font-medium text-timing-medium">
                  <CloudLightning className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{weather.label}</span>
                </span>
              </Tooltip>
            )}
          </p>
        )}
      </div>
      <div className="min-w-0 text-sm">
        {profileLoading && !profile ? (
          <div className="space-y-1.5"><Skeleton className="h-3 w-28" /><Skeleton className="h-3 w-20" /></div>
        ) : (
          <>
            <p className="truncate font-medium text-fg" title={contact.name ? [contact.name, contact.title].filter(Boolean).join(' · ') : contact.askFor ?? 'Main line'}>
              {contact.name ?? <span className="font-normal text-muted">{contact.askFor ?? 'Main line'}</span>}
              {contact.name && contact.title && <span className="font-normal text-muted"> · {contact.title}</span>}
            </p>
            <p className="truncate text-muted tabular-nums">
              {contact.phone ? <a href={toTel(contact.phone)} className="hover:text-accent hover:underline">{formatPhone(contact.phone)}</a> : 'No phone on file'}
            </p>
          </>
        )}
      </div>
      <RowActions row={row} phone={contact.phone} contactName={contact.name} onLog={onLog} />
      {pitch && (
        <p className="flex min-w-0 items-start gap-1.5 text-sm text-muted @min-[40rem]:col-span-2" data-testid="ai-pitch">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
          <span className="sr-only">AI pitch: </span>
          <span className="min-w-0 line-clamp-2" title={pitch}><span className="mr-1.5 text-[11px] font-semibold tracking-wide text-accent" aria-hidden>AI</span>{pitch}</span>
        </p>
      )}
    </li>
  );
}

function RowActions({ row, phone, contactName, onLog }: { row: BriefingRow; phone: string | null; contactName: string | null; onLog: () => void }) {
  const toast = useToast();
  const reschedule = useRescheduleTask();
  const schedule = useScheduleFollowUp();
  const busy = reschedule.isPending || schedule.isPending;
  const canWrite = row.lead ? row.lead.canWrite !== false : true;

  const pick = (choice: (typeof CHOICES)[number]['key']) => {
    const due = followUpDate(choice);
    const done = () => toast.success(row.task ? 'Follow-up moved' : 'Follow-up scheduled', `${row.leadName} · ${dayFmt.format(due)}`);
    const failed = (err: unknown) => (err instanceof VersionConflictError
      ? toast.warning('Someone just changed this follow-up', 'The list is refreshed. Try again.')
      : toast.error(err));
    if (row.task) {
      reschedule.mutate({ taskId: row.task.id, leadId: row.leadId, dueAt: due.toISOString(), version: row.task.version }, { onSuccess: done, onError: failed });
    } else {
      const who = contactName ? contactName.split(/\s+/)[0] : row.leadName;
      schedule.mutate({ leadId: row.leadId, title: `Call ${who}`, type: 'call', dueAt: due.toISOString() }, { onSuccess: done, onError: failed });
    }
  };

  return (
    // The action column is at least 21.5rem wide (ROW_GRID), so the four buttons fit on one line with a 12px inset.
    <div className="flex flex-wrap items-center gap-1.5 @min-[40rem]:flex-nowrap @min-[40rem]:justify-end">
      {phone ? (
        <a href={toTel(phone)} className={buttonClasses('roof', 'sm', 'h-8 max-sm:px-2.5 sm:px-3!')} aria-label={`Call ${row.leadName}`}>
          <Phone className="size-3.5" aria-hidden />Call
        </a>
      ) : (
        <Tooltip content="No phone number on file">
          <span className={buttonClasses('roof', 'sm', 'h-8 opacity-50 max-sm:px-2.5 sm:px-3!')} aria-disabled="true">
            <Phone className="size-3.5" aria-hidden />Call
          </span>
        </Tooltip>
      )}
      <Button size="sm" className="h-8 max-sm:px-2.5 sm:px-3!" leftIcon={<NotebookPen className="size-3.5 max-sm:hidden" />} onClick={onLog} disabled={!canWrite}>
        Log call
      </Button>
      <Menu
        align="end"
        items={CHOICES.map((c) => ({ label: c.label, onSelect: () => pick(c.key) }))}
        header={<span className="text-xs font-medium text-muted">{row.task ? 'Move this follow-up to' : 'Call again'}</span>}
        trigger={(props) => (
          <Button {...props} size="sm" className="h-8 max-sm:px-2.5 sm:px-3!" leftIcon={<CalendarClock className="size-3.5 max-sm:hidden" />} loading={busy} disabled={!canWrite}>
            {row.task ? 'Reschedule' : 'Follow up'}
          </Button>
        )}
      />
      <Tooltip content="Open lead" describe={false}>
        <Link to={`/leads/${row.leadId}`} className={buttonClasses('secondary', 'sm', 'size-8 px-0!')} aria-label={`Open ${row.leadName}`}>
          <ArrowRight className="size-4 shrink-0" aria-hidden />
        </Link>
      </Tooltip>
    </div>
  );
}

function BriefingSkeleton() {
  return (
    <ul className="divide-y divide-border" aria-hidden>
      {Array.from({ length: COLLAPSED_ROWS }, (_, i) => (
        <li key={i} className={cn('grid grid-cols-1 gap-x-4 gap-y-3 px-4 py-4 sm:py-4.5', ROW_GRID)}>
          <div className="space-y-1.5"><Skeleton className="h-4 w-44" /><Skeleton className="h-3 w-24" /></div>
          <div className="space-y-1.5"><Skeleton className="h-3.5 w-52" /><Skeleton className="h-3 w-36" /></div>
          <div className="space-y-1.5"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-3 w-24" /></div>
          <div className="flex gap-1.5 @min-[40rem]:justify-end"><Skeleton className="h-8 w-16" /><Skeleton className="h-8 w-20" /><Skeleton className="h-8 w-24" /></div>
        </li>
      ))}
    </ul>
  );
}
