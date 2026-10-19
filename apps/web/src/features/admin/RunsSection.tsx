// "Recent runs": each refresh (scheduled or Run now), who asked for it, how long it took, what it found.
import { ChevronDown, History, RefreshCw } from 'lucide-react';
import { Fragment, useState } from 'react';
import { errorMessage } from '@/api/errors';
import { Card, EmptyState, ErrorState, IconButton, Skeleton, SkeletonRows, TBody, TD, TH, THead, TR, Table } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { CardStat, SectionHeading, StatusChip, When } from './parts';
import { areaText, formatDuration, isActive, kindLabel, territoryName } from './lib';
import type { Run, Territory } from './types';

export interface RunsSectionProps {
  runs: Run[] | undefined;
  territories: Territory[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  isPhone: boolean;
  now: number;
}

export function RunsSection(p: RunsSectionProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const active = (p.runs ?? []).some((r) => isActive(r.status));
  const list = p.runs;

  return (
    <section aria-labelledby="runs-heading">
      <SectionHeading
        id="runs-heading"
        title="Recent runs"
        subtitle="Each time LeadMaker refreshed an area: who started it, how long it took and what it found"
        action={(
          <>
            <span className="text-xs text-subtle" aria-live="polite">{active ? 'Updating live' : 'Updates every 30 seconds'}</span>
            <IconButton
              size="sm"
              variant="secondary"
              label="Refresh runs"
              icon={<RefreshCw className={cn(p.isFetching && 'animate-spin')} />}
              onClick={p.onRetry}
            />
          </>
        )}
      />
      <Card className="overflow-hidden">
        {p.error && !list ? (
          <ErrorState message={errorMessage(p.error)} onRetry={p.onRetry} />
        ) : list && !list.length ? (
          <EmptyState
            icon={<History />}
            title="No runs yet"
            description="Runs show up here when an area refreshes on its schedule or someone presses Run now."
          />
        ) : p.isPhone ? (
          <PhoneList {...p} open={open} onToggle={toggle} />
        ) : (
          <Table aria-label="Recent runs" aria-busy={p.isLoading || undefined}>
            <THead>
              <tr>
                <TH className="pl-5 sm:pl-6">Status</TH>
                <TH>Area</TH>
                <TH>Requested by</TH>
                <TH>Started</TH>
                <TH align="right">Duration</TH>
                <TH align="right" hint="Contractors LeadMaker found in the area">Found</TH>
                <TH align="right" hint="Contractors that were not in LeadMaker before">New</TH>
                <TH align="right" hint="Existing leads with changed details">Updated</TH>
                <TH className="pr-5 sm:pr-6"><span className="sr-only">Error details</span></TH>
              </tr>
            </THead>
            <TBody>
              {!list ? <SkeletonRows rows={3} columns={9} /> : list.map((r) => (
                <Fragment key={r.jobId}>
                  <TR>
                    <TD className="pl-5 sm:pl-6"><StatusChip status={r.status} /></TD>
                    <TD><Area run={r} territories={p.territories} /></TD>
                    <TD className="whitespace-nowrap"><RequestedBy run={r} /></TD>
                    <TD className="whitespace-nowrap"><Started run={r} /></TD>
                    <TD align="right" className="whitespace-nowrap">{duration(r, p.now)}</TD>
                    <TD align="right">{stat(r, 'found')}</TD>
                    <TD align="right">{stat(r, 'new')}</TD>
                    <TD align="right">{stat(r, 'updated')}</TD>
                    <TD className="pr-5 text-right sm:pr-6">
                      {r.error && <ErrorToggle id={r.jobId} open={open.has(r.jobId)} onToggle={() => toggle(r.jobId)} />}
                    </TD>
                  </TR>
                  {r.error && open.has(r.jobId) && (
                    <tr id={errorId(r.jobId)} className="bg-surface-2">
                      <td colSpan={9} className="px-5 py-3 sm:px-6"><ErrorText text={r.error} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </section>
  );
}

function PhoneList({ runs, territories, now, open, onToggle }: RunsSectionProps & { open: ReadonlySet<string>; onToggle: (id: string) => void }) {
  if (!runs) {
    return (
      <div className="space-y-3 p-4" aria-hidden>
        {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  }
  return (
    <ul aria-label="Recent runs" className="divide-y divide-divider">
      {runs.map((r) => (
        <li key={r.jobId} className="space-y-3 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <Area run={r} territories={territories} />
            <StatusChip status={r.status} className="shrink-0" />
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <CardStat label="Requested by"><RequestedBy run={r} /></CardStat>
            <CardStat label="Started"><Started run={r} /></CardStat>
            <CardStat label="Duration">{duration(r, now)}</CardStat>
            <CardStat label="Found / new / updated">
              <span className="tabular">{stat(r, 'found')} / {stat(r, 'new')} / {stat(r, 'updated')}</span>
            </CardStat>
          </dl>
          {r.error && (
            <div>
              <ErrorToggle id={r.jobId} open={open.has(r.jobId)} onToggle={() => onToggle(r.jobId)} />
              {open.has(r.jobId) && <div id={errorId(r.jobId)} className="mt-2"><ErrorText text={r.error} /></div>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const errorId = (jobId: string) => `run-error-${jobId}`;

function ErrorToggle({ id, open, onToggle }: { id: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? errorId(id) : undefined}
      onClick={onToggle}
      className="inline-flex items-center gap-1 rounded-md text-sm font-medium whitespace-nowrap text-danger hover:underline"
    >
      {open ? 'Hide error' : 'Show error'}
      <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
    </button>
  );
}

function ErrorText({ text }: { text: string }) {
  return <pre className="max-h-48 overflow-auto rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 font-mono text-xs whitespace-pre-wrap text-danger">{text}</pre>;
}

function Area({ run, territories }: { run: Run; territories: Territory[] | undefined }) {
  const a = run.territory;
  const match = a ? territories?.find((t) => t.zip === a.zip && t.radiusMiles === a.radiusMiles) : undefined;
  const title = match ? territoryName(match) : a ? `ZIP ${a.zip}` : kindLabel(run.kind);
  const detail = [a && areaText(a.zip, a.radiusMiles), a && kindLabel(run.kind)].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-fg">{title}</p>
      {detail && <p className="text-xs text-muted tabular">{detail}</p>}
    </div>
  );
}

function RequestedBy({ run }: { run: Run }) {
  return run.requestedBy ? <span>{run.requestedBy.name}</span> : <span className="text-muted">Automatic</span>;
}

function Started({ run }: { run: Run }) {
  if (run.startedAt) return <When iso={run.startedAt} />;
  return <span className="text-muted">Waiting{run.createdAt && <> · added <When iso={run.createdAt} /></>}</span>;
}

/** Finished runs use the server's figure; a running one counts up from its start (refreshed with each poll). */
function duration(r: Run, now: number): string {
  if (r.durationMs != null) return formatDuration(r.durationMs);
  if (r.status === 'running' && r.startedAt) {
    const t = new Date(r.startedAt).getTime();
    if (Number.isFinite(t)) return formatDuration(Math.max(0, now - t));
  }
  return '—';
}

function stat(r: Run, k: 'found' | 'new' | 'updated') {
  return r.stats ? formatNumber(r.stats[k]) : <span className="text-subtle">—</span>;
}
