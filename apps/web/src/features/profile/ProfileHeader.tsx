import {
  Ban, Building2, CalendarClock, CalendarPlus, ChevronDown, CircleCheck, ExternalLink as ExternalLinkIcon, Handshake, History,
  Lock, Mail, Phone, PhoneCall, Star, Users,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '@/auth/AuthContext';
import { Avatar, Card, ExternalLink as SafeLink, Tooltip, buttonClasses } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime, formatNumber, formatRelative, humanize } from '@/lib/format';
import { ACCOUNT_STATUS_LABELS, CERTIFICATION_LABELS, SEGMENT_LABELS, isSegment, type Segment } from '@/lib/labels';
import { useProfile } from './context';
import { askFor, displayUrl, lastStateActor, mapsUrl, normalizeUrl, priorityDrivers, telHref } from './lib';
import { dayWord, dueState, nextTask, salesOf } from './sales';
import { StageSelector } from './StageSelector';
import { Highlight, ReadOnlyHint } from './ui';
import { WeatherLine } from './Weather';

export function ReadOnlyBanner() {
  const { profile, canEdit } = useProfile();
  if (canEdit) return null;
  const unallocated = !profile.allocation.current;
  return (
    <div role="status" className="mb-5 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3.5 sm:px-5">
      <Lock className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-fg">
          {unallocated ? 'Unallocated: ask a manager to assign it to you' : `Allocated to ${profile.allocation.current?.rep.name ?? 'another rep'}: view only`}
        </p>
        <p className="mt-1 text-muted">
          You can see everything on this lead, including the team’s notes, but you can’t edit it, log activity or mark it until it’s yours.
        </p>
      </div>
    </div>
  );
}

export function DoNotContactBanner() {
  const { profile } = useProfile();
  if (profile.details.accountStatus !== 'do_not_contact') return null;
  return (
    <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3.5 sm:px-5">
      <Ban className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <p className="text-sm text-fg">
        <span className="font-semibold">Do not contact.</span> This account is flagged in the distributor’s CRM import. Don’t call, email or visit.
      </p>
    </div>
  );
}

export function ProfileHeader({
  onLogCall, onAddFollowUp,
}: { onLogCall: () => void; onAddFollowUp: () => void }) {
  const { profile, canEdit, readOnlyReason, meId, openTab } = useProfile();
  const { isManager } = useAuth();
  const d = profile.details;
  const name = profile.fields.business_name.value ?? 'Unnamed contractor';
  const who = askFor(profile);
  const dnc = d.accountStatus === 'do_not_contact';
  const phone = dnc || who.doNotContact ? null : who.phone;
  const email = dnc || who.doNotContact ? null : who.email;
  const segment: Segment | null = isSegment(d.segment) ? d.segment : null;

  return (
    <Card className="mb-6 overflow-hidden lg:mb-7">
      <div className="space-y-5 p-4 sm:p-6">
        {/* identity + score */}
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 gap-4">
            <CompanyMark name={name} />
            <div className="min-w-0">
              <Highlight k="field:business_name" className="rounded-md">
                <h1 className="text-xl font-semibold tracking-tight break-words text-fg sm:text-2xl">{name}</h1>
              </Highlight>
              <MetaLine />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 md:flex-col md:items-end">
            <PriorityScore />
            <MyState />
          </div>
        </div>

        <StageSelector />

        {/* where the deal stands + what to do */}
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <SalesLine onAddFollowUp={onAddFollowUp} />
          <div className="grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:items-center">
            {phone && (
              <a href={telHref(phone)} className={buttonClasses('secondary', 'md')}>
                <Phone className="size-4" aria-hidden />Call
              </a>
            )}
            <ReadOnlyHint reason={canEdit ? null : readOnlyReason}>
              <button type="button" onClick={onLogCall} disabled={!canEdit} className={cn(buttonClasses('roof', 'md'), 'max-sm:w-full')}>
                <PhoneCall className="size-4" aria-hidden />Log call
              </button>
            </ReadOnlyHint>
            {email && (
              <a href={`mailto:${email}`} className={buttonClasses('secondary', 'md')}>
                <Mail className="size-4" aria-hidden />Email
              </a>
            )}
            <ReadOnlyHint reason={canEdit ? null : readOnlyReason}>
              <button type="button" onClick={onAddFollowUp} disabled={!canEdit} className={cn(buttonClasses('secondary', 'md'), 'max-sm:w-full')}>
                <CalendarPlus className="size-4" aria-hidden />Add follow-up
              </button>
            </ReadOnlyHint>
          </div>
        </div>
      </div>

      {/* key facts strip */}
      <dl className="grid grid-cols-2 gap-px border-t border-border bg-border md:grid-cols-3 xl:grid-cols-[1fr_1.25fr_1fr_1.25fr]">
        <StripCell label="Owner" highlightKey="owner">
          {profile.allocation.current ? (
            <div className="flex items-center gap-2">
              <Avatar name={profile.allocation.current.rep.name} size={24} />
              <div className="min-w-0">
                <p className="font-medium break-words text-fg">
                  {profile.allocation.current.rep.name}
                  {profile.allocation.current.rep.id === meId && <span className="font-normal text-muted"> (you)</span>}
                </p>
                <p className="text-xs text-muted">
                  Since {shortDate(profile.allocation.current.allocatedAt)} · by {profile.allocation.current.allocatedBy.name}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-surface-3 text-muted"><Users className="size-3.5" aria-hidden /></span>
              <div className="min-w-0">
                <p className="font-medium text-fg">Unallocated</p>
                {isManager ? (
                  <Link to="/allocation" className="text-xs font-medium text-accent hover:underline">Assign in Allocation</Link>
                ) : (
                  <p className="text-xs text-muted">In the shared pool</p>
                )}
              </div>
            </div>
          )}
          <AllocationHistory />
        </StripCell>
        <StripCell label="Who to ask for" highlightKey={who.contactId ? `contact:${who.contactId}` : undefined} className="max-md:col-span-2 max-xl:order-first">
          <p className="min-w-0 truncate text-fg">
            <span className="font-medium">{who.name ?? `The ${who.role.toLowerCase()}`}</span>
            <span className="text-muted"> · {who.role}</span>
          </p>
          {who.doNotContact ? (
            <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-danger"><Ban className="size-3.5" aria-hidden />Marked do not contact</p>
          ) : (
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              {who.phone && (
                <a href={telHref(who.phone)} className="inline-flex items-center gap-1 font-medium text-accent tabular hover:underline">
                  <Phone className="size-3.5" aria-hidden />{who.phone}
                  {who.mainLine && <span className="font-normal text-subtle">main line</span>}
                </a>
              )}
              {who.email && (
                <a href={`mailto:${who.email}`} className="inline-flex min-w-0 items-center gap-1 font-medium text-accent hover:underline">
                  <Mail className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{who.email}</span>
                </a>
              )}
              {!who.phone && !who.email && <span className="text-muted">No phone or email yet</span>}
              {profile.contacts.length > 1 && (
                <button type="button" onClick={() => openTab('contacts')} className="text-muted hover:text-fg hover:underline">
                  All {profile.contacts.length} contacts
                </button>
              )}
            </p>
          )}
        </StripCell>
        <StripCell label="Account">
          <p className="font-medium text-fg">{ACCOUNT_STATUS_LABELS[d.accountStatus]}</p>
          <p className="text-xs text-muted">{segment ? `${SEGMENT_LABELS[segment]} segment` : 'From the CRM import'}</p>
        </StripCell>
        <StripCell label="Weather" className="max-md:col-span-2 md:max-xl:col-span-3">
          <WeatherLine onDetails={() => openTab('weather')} />
        </StripCell>
      </dl>
    </Card>
  );
}

/** "Last contacted 3 days ago · Next follow-up Thu: Call Mike about the underlayment quote". */
function SalesLine({ onAddFollowUp }: { onAddFollowUp: () => void }) {
  const { profile, canEdit } = useProfile();
  const { lastContactedAt, tasks } = salesOf(profile);
  const next = nextTask(tasks);
  const state = next ? dueState(next) : null;
  return (
    <Highlight k="tasks" className="min-w-0 rounded-lg">
      <p className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
        <span className="inline-flex items-center gap-1.5 text-muted">
          <History className="size-4 shrink-0 text-subtle" aria-hidden />
          {lastContactedAt
            ? <>Last contacted <Tooltip content={formatDateTime(lastContactedAt)} describe={false}><time tabIndex={0} dateTime={lastContactedAt} className="font-medium text-fg">{formatRelative(lastContactedAt)}</time></Tooltip></>
            : <span className="font-medium text-fg">Not contacted yet</span>}
        </span>
        <span className="hidden text-subtle sm:inline" aria-hidden="true">·</span>
        {next ? (
          <span className="inline-flex min-w-0 items-start gap-1.5 text-muted">
            <CalendarClock className={cn('mt-0.5 size-4 shrink-0', state === 'overdue' ? 'text-roof' : 'text-accent')} aria-hidden />
            <span className="min-w-0">
              {state === 'overdue' ? <span className="font-medium text-roof">Follow-up overdue ({dayWord(next.dueAt)})</span> : <>Next follow-up <span className="font-medium text-fg">{dayWord(next.dueAt)}</span></>}
              : <span className="text-fg">{next.title}</span>
            </span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <CalendarClock className="size-4 shrink-0 text-subtle" aria-hidden />
            No follow-up scheduled
            {canEdit && <button type="button" onClick={onAddFollowUp} className="font-medium text-accent hover:underline">Add one</button>}
          </span>
        )}
      </p>
    </Highlight>
  );
}

function MetaLine() {
  const { profile } = useProfile();
  const d = profile.details;
  const city = [profile.fields.city.value, profile.fields.state.value].filter(Boolean).join(', ');
  const website = profile.fields.website_url.value;
  const cert = d.tier ? CERTIFICATION_LABELS[`gaf:${d.tier}` as keyof typeof CERTIFICATION_LABELS] ?? `GAF ${humanize(d.tier)}` : null;
  const maps = mapsUrl({ address: profile.fields.address.value, lat: d.latitude, lng: d.longitude, placeId: d.googlePlaceId });
  const items: ReactNode[] = [
    city && <SafeLink href={maps} fallback={city} className="hover:text-fg hover:underline">{city}</SafeLink>,
    d.contractorType,
    d.rating != null && (
      <span className="inline-flex items-center gap-1">
        <Star className="size-3.5 fill-current text-warning" aria-hidden />
        <span className="font-medium text-fg tabular">{d.rating.toFixed(1)}</span>
        <span>({formatNumber(d.reviewCount)} reviews)</span>
      </span>
    ),
    d.inBusinessSince ? `Since ${d.inBusinessSince}` : d.yearsInBusiness != null ? `${d.yearsInBusiness} yrs in business` : null,
    cert,
    website && (
      <SafeLink href={normalizeUrl(website)} fallback={null} className="inline-flex items-center gap-0.5 hover:text-fg hover:underline">
        {displayUrl(website)}<ExternalLinkIcon className="size-3" aria-hidden />
      </SafeLink>
    ),
  ].filter(Boolean);
  return (
    <ul className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted sm:gap-x-2.5">
      {items.map((it, i) => (
        <li key={i} className="inline-flex items-center gap-2.5">
          {i > 0 && <span className="hidden text-subtle sm:inline" aria-hidden="true">·</span>}
          {it}
        </li>
      ))}
    </ul>
  );
}

const sameYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "Oct 18" this year, "Oct 18, 2025" otherwise. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.getFullYear() === new Date().getFullYear() ? sameYear.format(d) : formatDate(iso);
}

function CompanyMark({ name }: { name: string }) {
  const letters = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <div
      aria-hidden="true"
      className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-base font-semibold text-accent sm:size-14 sm:text-lg"
    >
      {letters || <Building2 className="size-6" />}
    </div>
  );
}

function StripCell({
  label, children, highlightKey, className,
}: { label: string; children: ReactNode; highlightKey?: string; className?: string }) {
  return (
    <Highlight k={highlightKey} className={cn('min-w-0 bg-surface px-4 py-3.5 text-sm sm:px-6 sm:py-4', className)}>
      <dt className="mb-1.5 text-xs font-medium text-muted">{label}</dt>
      <dd>{children}</dd>
    </Highlight>
  );
}

function AllocationHistory() {
  const { profile } = useProfile();
  const past = profile.allocation.history.filter((a) => a.endedAt);
  if (!past.length) return null;
  return (
    <details className="mt-1.5 text-xs text-muted">
      <summary className="cursor-pointer text-accent hover:underline">Assignment history ({past.length})</summary>
      <ul className="mt-1 space-y-0.5">
        {past.map((a) => (
          <li key={`${a.rep.id}-${a.allocatedAt}`}>
            {a.rep.name}: {formatDate(a.allocatedAt)} – {formatDate(a.endedAt)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PriorityScore() {
  const { profile } = useProfile();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const score = profile.details.priorityScore;
  const drivers = priorityDrivers(profile.systemTags);
  const segment: Segment | null = isSegment(profile.details.segment) ? profile.details.segment : null;
  const tone = segment ? SEGMENT_TONE[segment] : 'text-muted';
  const max = Math.max(1, ...drivers.map((d) => Math.abs(d.points ?? 0)));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (score == null) return null;
  return (
    <div ref={root} className="relative shrink-0">
      <div className="flex items-center gap-2.5">
        <ScoreRing score={score} className={tone} />
        <div className="min-w-0 leading-tight">
          <p className="text-sm font-semibold text-fg tabular">
            {Math.round(score)}<span className="text-xs font-normal text-muted"> / 100 priority</span>
          </p>
          {drivers.length > 0 && (
            <button
              ref={trigger}
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-0.5 text-xs font-medium text-accent hover:underline"
            >
              Why this score?
              <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Priority score drivers"
          className="absolute top-full left-0 z-20 mt-2 w-72 rounded-xl border border-border bg-surface p-3 shadow-lg animate-[lm-pop-in_120ms_ease-out] md:right-0 md:left-auto"
        >
          <p className="text-xs font-semibold text-fg">Top drivers</p>
          <p className="mb-2.5 text-xs text-muted">Points these facts add to the {score.toFixed(1)} score.</p>
          <ul className="space-y-2">
            {drivers.map((dr) => (
              <li key={dr.label}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-fg">{dr.label}</span>
                  {dr.points != null && <span className="font-medium text-fg tabular">{dr.points > 0 ? '+' : ''}{dr.points}</span>}
                </div>
                {dr.points != null && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                    <div className={cn('h-full rounded-full bg-current', tone)} style={{ width: `${(Math.abs(dr.points) / max) * 100}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {segment && <p className="mt-2.5 border-t border-border pt-2 text-xs text-muted">Segment: <span className="font-medium text-fg">{SEGMENT_LABELS[segment]}</span></p>}
        </div>
      )}
    </div>
  );
}

const SEGMENT_TONE: Record<Segment, string> = {
  strategic: 'text-seg-strategic',
  growth: 'text-seg-growth',
  emerging: 'text-seg-emerging',
  long_tail: 'text-seg-long-tail',
};

function ScoreRing({ score, className }: { score: number; className?: string }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" className={cn('shrink-0 -rotate-90', className)} aria-hidden="true">
      <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="4.5" />
      <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`} />
    </svg>
  );
}

/** Checked / serviced for me: small toggles; who on the team did it is in their tooltips. */
function MyState() {
  const { profile, canEdit, readOnlyReason, m, meId } = useProfile();
  const mine = profile.state.mine;
  const who = (a: { name: string; isMe: boolean }) => (a.isMe ? 'you' : a.name);
  const checked = lastStateActor(profile, 'checked', meId);
  const serviced = lastStateActor(profile, 'serviced', meId);
  const stale = !mine.checked && !!mine.checkedAt;
  const hints = {
    checked: [
      mine.checked ? 'You reviewed this lead since its last change. Click to clear.' : 'Mark that you reviewed this lead.',
      checked ? `Last checked by ${who(checked)} ${formatRelative(checked.at)}.` : 'Not checked by anyone yet.',
      stale ? 'It changed since you checked it.' : null,
    ],
    serviced: [
      mine.serviced ? 'You have contacted this lead. Click to clear.' : 'Mark that you contacted this lead (logging a call, email or visit does this too).',
      serviced ? `Last serviced by ${who(serviced)} ${formatRelative(serviced.at)}.` : 'No calls, emails or visits logged yet.',
    ],
  };
  return (
    <Highlight k="state" className="flex gap-1.5 rounded-lg">
      {(['checked', 'serviced'] as const).map((kind) => {
        const on = mine[kind];
        const Icon = kind === 'checked' ? CircleCheck : Handshake;
        return (
          <ReadOnlyHint key={kind} reason={canEdit ? null : readOnlyReason} hint={canEdit ? hints[kind].filter(Boolean).join('\n') : null}>
            <button
              type="button"
              aria-pressed={on}
              disabled={!canEdit}
              aria-busy={m.setState.isPending || undefined}
              onClick={() => m.setState.mutate({ [kind]: !on })}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                'disabled:pointer-events-none disabled:opacity-50',
                on ? 'border-transparent bg-success-soft text-success' : 'border-border bg-surface text-muted hover:border-border-strong hover:text-fg',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {kind === 'checked' ? 'Checked' : 'Serviced'}
              {stale && kind === 'checked' && <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />}
              <span className="sr-only"> (for me)</span>
            </button>
          </ReadOnlyHint>
        );
      })}
    </Highlight>
  );
}
