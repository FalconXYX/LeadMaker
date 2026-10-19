// Tool results inside an answer: "Applied filters" (with Undo / Apply again), "Opened <lead>", sources.
import { ArrowRight, Building2, Check, FileText, Info, ListFilter, Redo2, Undo2 } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getLead } from '@/api/endpoints';
import { qk } from '@/api/queries';
import type { LeadProfile } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { Button, Tooltip, buttonClasses } from '@/components/ui';
import { cn } from '@/lib/cn';
import { humanize } from '@/lib/format';
import { searchParamsToFilter } from '@/lib/filterUrl';
import { useAssistant } from './context';
import { describeFilter, sameFilter } from './filters';
import type { Citation, FilterPart, InvalidFilterPart, OpenLeadPart } from './state';

const MAX_CHIPS = 8;

export function FilterCard({ part }: { part: FilterPart }) {
  const { undoFilter, reapplyFilter, onNavigate, isOverlay, busy } = useAssistant();
  const { isManager } = useAuth();
  const { pathname, search } = useLocation();
  const isCurrent = pathname === '/leads' && sameFilter(searchParamsToFilter(new URLSearchParams(search)), part.filter);
  const active = isCurrent && !part.undone;
  const chips = describeFilter(part.filter, { isManager });
  const shown = chips.slice(0, MAX_CHIPS);

  return (
    <div
      className={cn(
        'rounded-xl border bg-surface p-3.5 shadow-sm transition-colors',
        active ? 'border-accent/35' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5',
            active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted',
          )}
          aria-hidden
        >
          {active ? <Check /> : <ListFilter />}
        </span>
        <p className="min-w-0 flex-1 text-[13px] font-semibold text-fg">
          {part.undone ? 'Filters undone' : 'Applied filters'}
          {part.matchCount !== undefined && !part.undone && (
            <span className="text-xs font-normal text-muted"> · {matchCountLabel(part.matchCount, part.matchCountCapped)}</span>
          )}
          {active && <span className="sr-only"> (showing on the lead list)</span>}
        </p>
        {active ? (
          <Button
            size="sm" variant="ghost" leftIcon={<Undo2 className="size-3.5" />} disabled={busy} className="max-md:min-h-11"
            // On phones the list is behind the overlay: close it so the undone list is what the rep sees.
            onClick={() => { undoFilter(part); if (isOverlay) onNavigate(); }}
          >
            Undo
          </Button>
        ) : (
          <Button size="sm" variant="ghost" leftIcon={<Redo2 className="size-3.5" />} onClick={() => reapplyFilter(part)} disabled={busy} className="max-md:min-h-11">
            Apply again
          </Button>
        )}
      </div>
      {part.explanation && !part.undone && <p className="mt-1.5 text-[13px] leading-snug text-muted">{part.explanation}</p>}
      {chips.length > 0 ? (
        <ul className={cn('mt-2.5 flex flex-wrap gap-1.5', part.undone && 'opacity-60')} aria-label="Filters">
          {shown.map((c) => (
            <li key={c.id} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 text-xs">
              <span className="shrink-0 text-subtle">{c.facet}</span>
              <span className="truncate font-medium text-fg">{c.label}</span>
            </li>
          ))}
          {chips.length > shown.length && (
            <li className="inline-flex h-6 items-center px-1 text-xs text-muted">+{chips.length - shown.length} more</li>
          )}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-muted">No filters: showing every lead you can see.</p>
      )}
      {active && isOverlay && (
        <Link to={part.href} onClick={onNavigate} className={buttonClasses('subtle', 'sm', 'mt-3 w-full max-md:min-h-11')}>
          View matching leads <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      )}
    </div>
  );
}

/** "37 leads", "1 lead", "1,000+ leads" (the server stops counting at 1,000). */
export function matchCountLabel(n: number, capped?: boolean): string {
  if (capped) return `${n.toLocaleString('en-US')}+ leads`;
  return `${n.toLocaleString('en-US')} lead${n === 1 ? '' : 's'}`;
}

export function InvalidFilterCard({ part }: { part: InvalidFilterPart }) {
  return (
    <div className="flex gap-2 rounded-xl border border-border bg-surface-2 p-3 text-[13px] text-fg">
      <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <div>
        <p className="font-medium">Couldn’t apply those filters</p>
        <p className="text-muted">{part.explanation || 'The suggested filter wasn’t valid, so your list was left as it was.'}</p>
      </div>
    </div>
  );
}

export function OpenLeadCard({ part }: { part: OpenLeadPart }) {
  const { onNavigate } = useAssistant();
  const name = useLeadName(part.leadId);
  return (
    <Link
      to={part.href}
      onClick={onNavigate}
      className="group flex items-center gap-2.5 rounded-xl border border-border bg-surface p-2.5 shadow-sm transition-colors hover:border-border-strong hover:bg-surface-2"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted group-hover:bg-surface" aria-hidden>
        <Building2 className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] text-muted">Opened lead</span>
        <span className="block truncate text-[13px] font-medium text-fg">{name ?? 'Lead profile'}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}

// ---- citations ------------------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  notes: 'Notes',
  activity: 'Activity',
  insights: 'AI insights',
  'insights.summary': 'AI summary',
  'insights.pitch': 'Pitch angle',
  contacts: 'Contacts',
  targetContact: 'Target contact',
  timing: 'Weather timing',
  weather: 'Weather timing',
  systemTags: 'Tags',
  customTags: 'Custom tags',
  customFields: 'Custom fields',
  details: 'Company details',
  fields: 'Company info',
  description: 'Description',
  website: 'Website',
};

/** The profile tab a cited field lives on. Company details and the website are on Overview (the default tab). */
const FIELD_TABS: Record<string, string> = {
  contacts: 'contacts',
  targetContact: 'contacts',
  systemTags: 'tags',
  customTags: 'tags',
  customFields: 'tags',
  timing: 'weather',
  weather: 'weather',
};

export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]!;
  const head = field.split(/[.[]/)[0] ?? field;
  if (FIELD_LABELS[head]) return FIELD_LABELS[head]!;
  const last = field.split('.').at(-1) ?? field;
  return humanize(last.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
}

export function citationHref(c: Citation): string {
  const head = c.field.split(/[.[]/)[0] ?? c.field;
  const tab = FIELD_TABS[c.field] ?? FIELD_TABS[head];
  return `/leads/${encodeURIComponent(c.leadId)}${tab ? `?tab=${tab}` : ''}`;
}

export function Sources({ citations, currentLeadId }: { citations: Citation[]; currentLeadId?: string }) {
  const { onNavigate } = useAssistant();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">Sources</span>
      {citations.map((c) => (
        <CitationChip key={`${c.leadId}:${c.field}`} citation={c} showLead={c.leadId !== currentLeadId} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function CitationChip({ citation, showLead, onNavigate }: { citation: Citation; showLead: boolean; onNavigate: () => void }) {
  const cachedName = useLeadName(citation.leadId);
  const name = citation.leadName ?? cachedName;
  const field = fieldLabel(citation.field);
  const label = showLead ? `${name ?? 'Lead'} · ${field}` : field;
  return (
    <Tooltip content={`${name ?? 'Lead'}: ${field}`} describe={false}>
      <Link
        to={citationHref(citation)}
        onClick={onNavigate}
        className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border bg-surface px-2 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
      >
        <FileText className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </Link>
    </Tooltip>
  );
}

/** A lead's name from the query cache only (never fetches): set once the profile page has loaded it. */
function useLeadName(leadId: string): string | null {
  const q = useQuery({
    queryKey: qk.leads.detail(leadId),
    queryFn: ({ signal }) => getLead(leadId, { signal }),
    enabled: false,
    select: (p: LeadProfile) => p.fields.business_name.value,
  });
  return q.data ?? null;
}
