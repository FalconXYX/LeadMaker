// "New leads worth a call": leads LeadMaker found that nobody has called yet, ranked with their AI insight. One card,
// one row per lead: who and where, the priority, the AI's one-line summary, and Open / Call.
import { ArrowRight, Phone, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, Skeleton, Tooltip, buttonClasses } from '@/components/ui';
import { countyName } from '@/lib/counties';
import { cn } from '@/lib/cn';
import type { AiPick, DashboardData, DashboardScope } from './api';
import { bestContact, formatPhone, toTel } from './callList';
import { AiMark, CardError, MoreLink, Section } from './parts';
import { useLeadDetails } from './queries';
import { salesLeadsHref } from './sales';

const foundFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function place(p: AiPick): string | null {
  const county = p.county ? (/^\d{5}$/.test(p.county) ? countyName(p.county, { state: false }) : p.county) : null;
  const countyText = county ? (/county/i.test(county) ? county : `${county} County`) : null;
  return [p.city, countyText].filter(Boolean).join(' · ') || null;
}

function foundLabel(p: AiPick): string {
  if (p.label === 'new') {
    const d = p.foundAt ? new Date(p.foundAt) : null;
    return d && !Number.isNaN(d.getTime()) ? `New · found ${foundFmt.format(d)}` : 'New';
  }
  return 'Top match';
}

export function AiPicksCard({
  scope, data, error, onRetry, className,
}: { scope: DashboardScope; data: DashboardData | undefined; error: unknown; onRetry: () => void; className?: string }) {
  const picks = data?.aiPicks ?? [];
  const details = useLeadDetails(picks.map((p) => p.id));
  return (
    <Section
      id="ai-picks"
      title={<span className="inline-flex items-center gap-2">AI picks <AiMark /></span>}
      description="Leads nobody has called yet, best first"
      className={className}
      accent="blue"
      level={3}
      bodyClassName="px-0 pb-1"
      action={<MoreLink to={salesLeadsHref(scope, { stages: ['new'], sort: { by: 'priority_score', dir: 'desc' } })}>See all new leads</MoreLink>}
    >
      {!data ? (
        error ? <div className="px-4 pb-4 sm:px-6"><CardError error={error} onRetry={onRetry} /></div> : (
          <ul className="divide-y divide-border" aria-hidden>
            {Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="space-y-1.5 px-4 py-3.5 sm:px-6"><Skeleton className="h-4 w-52" /><Skeleton className="h-3 w-3/4" /></li>
            ))}
          </ul>
        )
      ) : !picks.length ? (
        <EmptyState
          compact
          className="py-5"
          icon={<Sparkles />}
          title="No new picks right now"
          description="When LeadMaker finds new contractors in your territory, the best ones show up here."
        />
      ) : (
        <ol className="divide-y divide-border" aria-label="AI picks">
          {picks.map((p) => {
            const d = details.get(p.id);
            const contact = bestContact(d?.data, null);
            const where = place(p);
            return (
              <li key={p.id} className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3.5 sm:px-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <Link to={`/leads/${p.id}`} title={p.name} className="block truncate text-[15px] font-semibold text-fg hover:text-accent hover:underline">{p.name}</Link>
                  <p className="flex min-w-0 items-center gap-2 text-sm text-muted">
                    <span className="truncate" title={where ?? undefined}>{where ?? 'Location unknown'}</span>
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                    <span className={cn('inline-flex h-5 items-center rounded-full px-2 font-medium', p.label === 'new' ? 'bg-success-soft text-success' : 'bg-accent-soft text-accent')}>
                      {foundLabel(p)}
                    </span>
                    {p.priorityScore != null && (
                      <Tooltip content="LeadMaker’s priority score, out of 100">
                        <span className="text-muted tabular-nums">Priority <span className="font-semibold text-fg">{Math.round(p.priorityScore)}</span></span>
                      </Tooltip>
                    )}
                  </p>
                  {(p.aiSummary || p.aiPitch) && (
                    <p className="mt-1 flex min-w-0 items-start gap-1.5 text-sm text-muted">
                      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
                      <span className="sr-only">AI summary: </span>
                      <span className="min-w-0 truncate" title={[p.aiSummary, p.aiPitch].filter(Boolean).join(' ')}>
                        <span className="mr-1.5 text-[11px] font-semibold tracking-wide text-accent" aria-hidden>AI</span>{p.aiSummary ?? p.aiPitch}
                      </span>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 md:justify-end">
                  {contact.phone ? (
                    <a href={toTel(contact.phone)} className={buttonClasses('roof', 'sm', 'h-8 px-3!')} aria-label={`Call ${p.name}`} title={formatPhone(contact.phone)}>
                      <Phone className="size-3.5" aria-hidden />Call
                    </a>
                  ) : (
                    <Tooltip content={d?.isLoading ? 'Looking up the phone number…' : 'No phone number on file'}>
                      <span className={buttonClasses('roof', 'sm', 'h-8 px-3! opacity-50')} aria-disabled="true">
                        <Phone className="size-3.5" aria-hidden />Call
                      </span>
                    </Tooltip>
                  )}
                  <Link to={`/leads/${p.id}`} className={buttonClasses('secondary', 'sm', 'h-8 px-3!')} aria-label={`Open ${p.name}`}>
                    Open<ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
