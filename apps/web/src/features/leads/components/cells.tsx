// Cell renderers shared by the desktop table and the mobile cards.
import {
  Award, CalendarCheck, CircleCheck, CircleDashed, Handshake, Mail, MapPin, Phone, Shield, ShieldCheck, Star, UserRound,
} from 'lucide-react';
import type { LeadSummary, SessionUser } from '@/api/types';
import { readOnlyReason } from '@/auth/permissions';
import {
  Avatar, Badge, CustomTagBadge, PriorityMeter, SystemTagBadge, TimingBadge, Tooltip, segmentBarClass,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { SEGMENT_LABELS, isSegment } from '@/lib/labels';
import type { StateChange } from '../queries';
import {
  TASK_TYPE_LABELS, decisionMaker, followUpText, lastContactedText, type NextTask, type TaskType,
} from '../sales';
import { TIER_LABELS, rankingReasons, type ChipTag } from '../tags';
import { ALERT_BADGE_KEYS, type ListTimingBadge } from '../timing';

const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const SEGMENT_TEXT: Record<string, string> = {
  strategic: 'text-seg-strategic',
  growth: 'text-seg-growth',
  emerging: 'text-seg-emerging',
  long_tail: 'text-seg-long-tail',
};

/** The segment as small coloured text, for cells that also show the score (the folded table). */
export function SegmentLabel({ segment }: { segment: string | null }) {
  if (!isSegment(segment)) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 pl-0.5 text-[11px] leading-none font-medium', SEGMENT_TEXT[segment])}>
      <span aria-hidden className={cn('size-1.5 rounded-full', segmentBarClass(segment))} />
      {SEGMENT_LABELS[segment]}
    </span>
  );
}

export const PriorityScore = PriorityMeter;

/** City and the decision-maker the pipeline found, the line under the company name. */
export function CompanyMeta({ lead, className }: { lead: Pick<LeadSummary, 'city' | 'state' | 'tags' | 'distanceMiles'>; className?: string }) {
  const dm = decisionMaker(lead);
  const place = [lead.city, lead.state].filter(Boolean).join(', ') || 'Location unknown';
  return (
    <span className={cn('flex min-w-0 items-center gap-x-2 text-xs text-muted', className)}>
      <span className="inline-flex min-w-0 shrink items-center gap-1 truncate">
        <MapPin className="size-3 shrink-0 text-subtle" aria-hidden />
        <span className="truncate">{place}{lead.distanceMiles != null ? ` · ${lead.distanceMiles.toFixed(1)} mi` : ''}</span>
      </span>
      {dm && (
        <Tooltip content={dm.label.replace(/^DM:\s*/, 'Decision-maker: ')} describe={false}>
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <UserRound className="size-3 shrink-0 text-subtle" aria-hidden />
            <span className="sr-only">Contact: </span>
            <span className="truncate">{dm.name}</span>
          </span>
        </Tooltip>
      )}
    </span>
  );
}

const TASK_ICONS: Record<TaskType, typeof Phone> = { call: Phone, email: Mail, visit: MapPin, todo: CalendarCheck };

/** "Today", "Overdue 2d" (red), "Thu" and, below, what the follow-up is. */
export function NextFollowUp({ task, showTitle = true, className }: { task: NextTask | null; showTitle?: boolean; className?: string }) {
  const text = task ? followUpText(task.dueAt) : null;
  if (!task || !text) {
    return <span className={cn('text-[13px] text-subtle', className)}>—<span className="sr-only">No follow-up</span></span>;
  }
  const Icon = TASK_ICONS[task.type] ?? CalendarCheck;
  const overdue = text.tone === 'overdue';
  return (
    <Tooltip content={`${TASK_TYPE_LABELS[task.type] ?? 'Follow-up'}: ${task.title}\nDue ${formatDateTime(task.dueAt)}`} describe={false}>
      <span className={cn('flex min-w-0 flex-col', className)}>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap',
            overdue ? 'font-semibold text-roof' : text.tone === 'today' ? 'font-semibold text-warning' : 'text-fg',
          )}
        >
          <Icon className={cn('size-3.5 shrink-0', overdue ? 'text-roof' : text.tone === 'today' ? 'text-warning' : 'text-accent')} aria-hidden />
          <span className="sr-only">Next follow-up: </span>{text.label}
        </span>
        {showTitle && <span className="truncate pl-5 text-xs text-muted">{task.title}</span>}
      </span>
    </Tooltip>
  );
}

export function LastContacted({ at, className }: { at: string | null; className?: string }) {
  const text = lastContactedText(at);
  if (!text) return <span className={cn('text-[13px] text-subtle', className)}><span className="sr-only">Last contacted: </span>Never</span>;
  return (
    <Tooltip content={`Last call, email or visit: ${formatDateTime(at)}`} describe={false}>
      <span className={cn('text-[13px] whitespace-nowrap text-fg', className)}><span className="sr-only">Last contacted </span>{text}</span>
    </Tooltip>
  );
}

/** Weather worth a call (an NWS alert, or a high-severity badge): one small chip. Routine storm history is left out. */
export function weatherChip(badges: readonly ListTimingBadge[]): ListTimingBadge | null {
  return badges.find((b) => ALERT_BADGE_KEYS.has(b.key) || b.severity === 'high') ?? null;
}

/** The top ranking reasons as one line, plus a small weather chip when the weather matters. */
export function Why({
  lead, badges, compact, className,
}: { lead: Pick<LeadSummary, 'priorityDrivers' | 'tags'>; badges: readonly ListTimingBadge[]; compact?: boolean; className?: string }) {
  const reasons = rankingReasons(lead, 2);
  const chip = weatherChip(badges);
  return (
    <div className={cn('flex min-w-0 gap-1', compact ? 'flex-row-reverse items-center justify-end' : 'flex-col items-start', className)}>
      {reasons.length ? (
        <Tooltip content={reasons.map((r) => `${r.driver}: ${r.label}`).join('\n')} describe={false}>
          <p className={cn('min-w-0 text-[13px] leading-snug text-fg', compact ? 'truncate' : 'line-clamp-2')}>
            <span className="sr-only">Top ranking reasons: </span>
            {reasons[0]!.label}
            {reasons[1] && <span className="text-muted"> · {reasons[1].label}</span>}
          </p>
        </Tooltip>
      ) : <span className="text-subtle">—</span>}
      {chip && (
        <TimingBadge
          badge={{ label: chip.short, severity: chip.severity, reason: badges.map((b) => `${b.label}: ${b.reason}`).join('\n') }}
          className={compact ? 'shrink-0' : 'max-w-full'}
        />
      )}
    </div>
  );
}

export function GafTier({ tier, compact, size = 'sm' }: { tier: string | null; compact?: boolean; size?: 'xs' | 'sm' }) {
  const label = tier ? TIER_LABELS[tier] : undefined;
  if (!label) return <Tooltip content="Not GAF certified"><span className="text-subtle">—</span></Tooltip>;
  const Icon = tier === 'master_elite' ? Award : tier === 'certified_plus' ? ShieldCheck : Shield;
  return (
    <Tooltip content={`GAF ${label} contractor`}>
      <span
        className={cn(
          'inline-flex max-w-full items-center whitespace-nowrap',
          size === 'xs' ? 'gap-1 text-xs' : 'gap-1.5 text-[13px]',
          tier === 'master_elite' ? cn('font-medium', size === 'xs' ? 'text-fg/80' : 'text-fg') : 'text-muted',
        )}
      >
        <Icon
          className={cn(size === 'xs' ? 'size-3.5' : 'size-4', 'shrink-0', tier === 'master_elite' ? 'text-warning' : tier === 'certified_plus' ? 'text-accent' : 'text-subtle')}
          aria-hidden
        />
        {size === 'xs' && <span className="sr-only">GAF </span>}
        {compact ? label.replace('Certified ', 'Cert. ') : label}
      </span>
    </Tooltip>
  );
}

export function Rating({ rating, reviews, size = 'sm' }: { rating: number | null; reviews: number; size?: 'xs' | 'sm' }) {
  if (rating == null) return <Tooltip content="No rating yet"><span className="text-subtle">—</span></Tooltip>;
  return (
    <Tooltip content={`${rating.toFixed(1)} stars from ${formatNumber(reviews)} reviews`}>
      <span className={cn('inline-flex items-center whitespace-nowrap', size === 'xs' ? 'gap-0.5 text-xs' : 'gap-1')}>
        <Star className={cn(size === 'xs' ? 'size-3' : 'size-3.5', 'fill-warning text-warning')} aria-hidden />
        <span className={cn('font-medium tabular', size === 'xs' ? 'text-fg/80' : 'text-fg')}>{rating.toFixed(1)}</span>
        <span className="text-xs tabular text-subtle">({reviews >= 1000 ? compactNumber.format(reviews) : formatNumber(reviews)})</span>
      </span>
    </Tooltip>
  );
}

export function Owner({ rep, userId, size = 'sm', className }: { rep: LeadSummary['assignedRep']; userId?: string; size?: 'xs' | 'sm'; className?: string }) {
  const xs = size === 'xs';
  if (!rep) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-subtle', xs ? 'text-xs' : 'text-sm', className)}>
        <CircleDashed className={cn('shrink-0', xs ? 'size-3.5' : 'size-5')} aria-hidden />
        Unallocated
      </span>
    );
  }
  const you = rep.id === userId;
  return (
    <Tooltip content={you ? `${rep.name} (you)` : rep.name} describe={false}>
      <span className={cn('inline-flex min-w-0 items-center', xs ? 'gap-1 text-xs' : 'gap-1.5 text-sm', className)}>
        <Avatar name={rep.name} size={xs ? 16 : 20} />
        <span className={cn('truncate', you ? 'font-medium text-fg' : 'text-muted')}>{you ? 'You' : rep.name}</span>
      </span>
    </Tooltip>
  );
}

export function TagChips({ chips, max = 3, nowrap, className }: { chips: readonly ChipTag[]; max?: number; nowrap?: boolean; className?: string }) {
  if (!chips.length) return null;
  const shown = chips.slice(0, max);
  const rest = chips.slice(max);
  return (
    <ul className={cn('flex min-w-0 items-center gap-1', nowrap ? 'flex-nowrap overflow-hidden' : 'flex-wrap', className)} aria-label="Tags">
      {shown.map((c) => (
        <li key={c.id} className="min-w-0 max-w-full">
          {c.kind === 'custom' ? <CustomTagBadge name={c.label} className="max-w-[180px]" /> : <SystemTagBadge label={c.label} className="max-w-[180px]" />}
        </li>
      ))}
      {rest.length > 0 && (
        <li>
          <Badge variant="neutral" tooltip={rest.map((c) => c.label).join(', ')}>+{rest.length}</Badge>
        </li>
      )}
    </ul>
  );
}

/** Checked / serviced quick toggles. Read-only leads keep them focusable (aria-disabled) so the reason shows. */
export function StateToggles({
  lead, user, onToggle, size = 'sm',
}: {
  lead: LeadSummary;
  user: Pick<SessionUser, 'id' | 'role'> | null;
  onToggle: (lead: LeadSummary, change: StateChange) => void;
  size?: 'sm' | 'md';
}) {
  const reason = readOnlyReason(user, lead);
  const items = [
    {
      key: 'checked' as const,
      on: lead.mine.checked,
      team: lead.team.checked,
      at: lead.mine.checkedAt,
      Icon: CircleCheck,
      onLabel: 'Checked',
      offLabel: 'Mark checked',
      teamText: 'checked by a teammate',
      onCls: 'border-success/30 bg-success-soft text-success',
    },
    {
      key: 'serviced' as const,
      on: lead.mine.serviced,
      team: lead.team.serviced,
      at: lead.mine.servicedAt,
      Icon: Handshake,
      onLabel: 'Serviced',
      offLabel: 'Mark serviced',
      teamText: 'serviced by a teammate',
      onCls: 'border-accent/30 bg-accent-soft text-accent',
    },
  ];
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`Status for ${lead.businessName}`}>
      {items.map(({ key, on, team, at, Icon, onLabel, offLabel, teamText, onCls }) => {
        const title = reason
          ?? (on ? `${onLabel} by you${at ? ` on ${formatDate(at)}` : ''}. Click to undo.` : `${offLabel}${team ? ` (already ${teamText})` : ''}`);
        return (
          <Tooltip key={key} content={title}>
            <button
              type="button"
              aria-pressed={on}
              aria-disabled={reason ? true : undefined}
              aria-label={`${onLabel}: ${lead.businessName}`}
              onClick={(e) => {
                e.stopPropagation();
                if (!reason) onToggle(lead, { [key]: !on });
              }}
              className={cn(
                'relative inline-flex items-center justify-center gap-1 rounded-md border transition-colors',
                size === 'sm' ? 'size-7' : 'h-8 px-2.5 text-xs font-medium',
                on ? onCls : 'border-border bg-surface text-subtle',
                reason ? 'cursor-not-allowed opacity-45' : !on && 'hover:border-border-strong hover:text-fg',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {size === 'md' && <span>{onLabel}</span>}
              {!on && team && (
                <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2 rounded-full border border-surface bg-success" />
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
