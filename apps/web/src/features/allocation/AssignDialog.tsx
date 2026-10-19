import { AlertTriangle, Inbox, Info } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LeadSummary } from '@/api/types';
import { Avatar, Badge, Button, Dialog, Field, Select, segmentVariant } from '@/components/ui';
import { cn } from '@/lib/cn';
import { countyPlace } from '@/lib/counties';
import { firstName, plural, segmentBreakdown, type RepLoad } from './lib';

export interface AssignDialogProps {
  open: boolean;
  onClose: () => void;
  mode: 'ids' | 'filter';
  reps: RepLoad[];
  poolSize: number | null;
  /** Most leads one allocation may move (GET /api/config); null until it is known. */
  maxBulk: number | null;
  initialRepId: string | null;
  /** How many leads the action covers. */
  count: number;
  /** filter mode: the search stopped counting, so count is a lower bound. */
  capped?: boolean;
  /** The leads, when the client has them all (drives the summary). */
  known: LeadSummary[];
  /** filter mode: where the matched leads live now (null = the pool). */
  sourceRepId?: string | null;
  /** filter mode: human-readable description of the filter. */
  filterChips?: string[];
  onConfirm: (repId: string) => void;
  pending: boolean;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Confirms an assignment: pick the rep, see what moves, and each affected load before and after. */
export function AssignDialog(props: AssignDialogProps) {
  const { open, onClose, mode, reps, poolSize, maxBulk, initialRepId, count, capped, known, sourceRepId, filterChips, onConfirm, pending } = props;
  const [repId, setRepId] = useState(initialRepId ?? '');
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) setRepId(initialRepId ?? reps[0]?.id ?? '');
  }, [open, initialRepId]); // reps may refetch while open: keep the user's choice

  const rep = reps.find((r) => r.id === repId) ?? null;
  const countLabel = `${fmt(count)}${capped ? '+' : ''}`;
  // Explicit ids are sent in batches of maxBulk; one by-filter request must stay under it.
  const overMax = mode === 'filter' && maxBulk !== null && count > maxBulk;

  // Where the leads come from: per current owner (null = pool).
  const sources = useMemo(() => {
    const m = new Map<string | null, number>();
    if (mode === 'filter') {
      m.set(sourceRepId ?? null, count);
      return m;
    }
    for (const l of known) {
      const k = l.assignedRep?.id ?? null;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    const unknown = count - known.length;
    if (unknown > 0) m.set(null, (m.get(null) ?? 0) + unknown);
    return m;
  }, [mode, known, count, sourceRepId]);

  const already = rep ? sources.get(rep.id) ?? 0 : 0;
  const incoming = Math.max(0, count - already);

  const rows: LoadRowData[] = [];
  if (rep) {
    rows.push({ key: rep.id, name: rep.name, before: rep.allocated, after: rep.allocated + incoming, capped, highlight: true });
  }
  for (const [src, n] of sources) {
    if (src === rep?.id || n === 0) continue;
    if (src === null) {
      if (poolSize !== null) rows.push({ key: 'pool', name: 'Unallocated pool', pool: true, before: poolSize, after: Math.max(0, poolSize - n), capped, scale: poolSize });
    } else {
      const r = reps.find((x) => x.id === src);
      if (r) rows.push({ key: r.id, name: r.name, before: r.allocated, after: Math.max(0, r.allocated - n), capped });
    }
  }
  const scaleMax = Math.max(1, ...rows.filter((r) => !r.pool).map((r) => Math.max(r.before, r.after)), ...reps.map((r) => r.allocated));
  // Leads from the pool add to the team's total; reassignments between reps do not.
  const avgAfter = reps.length ? (reps.reduce((n, r) => n + r.allocated, 0) + (sources.get(null) ?? 0)) / reps.length : 0;

  const reassigning = [...sources.entries()].filter(([k, n]) => k !== null && k !== rep?.id && n > 0);
  const verb = reassigning.length && !sources.get(null) ? 'Reassign' : 'Assign';
  const title = rep
    ? `${verb} ${mode === 'filter' ? 'all ' : ''}${countLabel} ${count === 1 && !capped ? 'lead' : 'leads'} to ${firstName(rep.name)}?`
    : `${verb} ${countLabel} leads`;

  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onClose}
      size="md"
      title={title}
      description={mode === 'filter'
        ? 'Every lead matching the current filter moves in one step.'
        : 'Review what moves before you confirm. You can undo right after.'}
      initialFocus={confirmRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            ref={confirmRef}
            variant="primary"
            loading={pending}
            disabled={!rep || overMax || incoming === 0}
            onClick={() => rep && onConfirm(rep.id)}
          >
            {verb} {countLabel} {count === 1 && !capped ? 'lead' : 'leads'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Assign to">
          {(p) => (
            <Select
              {...p}
              value={repId}
              onValueChange={setRepId}
              options={reps.map((r) => ({
                value: r.id,
                label: `${r.name} · ${fmt(r.allocated)} leads${sources.get(r.id) ? ` (has ${sources.get(r.id)} of these)` : ''}`,
              }))}
            />
          )}
        </Field>

        {mode === 'filter' && (
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <div className="text-xs font-medium text-muted">Matching</div>
            <div className="mt-0.5 text-2xl font-semibold tracking-tight text-fg">
              {countLabel} <span className="text-sm font-normal text-muted">{count === 1 && !capped ? 'lead' : 'leads'}</span>
            </div>
            {filterChips && filterChips.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {filterChips.map((c) => <Badge key={c} variant="neutral">{c}</Badge>)}
              </div>
            )}
          </div>
        )}

        {overMax && (
          <Notice tone="danger" icon={<AlertTriangle />}>
            {capped ? 'More than ' : ''}{fmt(count)} leads match, but up to {fmt(maxBulk ?? 0)} can be assigned at a time. Narrow the filter first.
          </Notice>
        )}
        {capped && !overMax && (
          <Notice tone="warning" icon={<Info />}>
            More than {fmt(count)} leads match. All of them{maxBulk !== null ? ` (up to ${fmt(maxBulk)})` : ''} will be assigned; the confirmation shows the exact number.
          </Notice>
        )}
        {rep && already > 0 && (
          <Notice tone="info" icon={<Info />}>
            {plural(already, 'lead')} already {already === 1 ? 'belongs' : 'belong'} to {firstName(rep.name)} and will be left as {already === 1 ? 'is' : 'they are'}.
          </Notice>
        )}

        {rows.length > 0 && (
          <section aria-label="Load before and after">
            <h3 className="mb-2 text-xs font-medium text-muted">Load before → after</h3>
            <ul className="flex flex-col gap-3">
              {rows.map((r) => <LoadRow key={r.key} row={r} scaleMax={scaleMax} />)}
            </ul>
            {reps.length > 1 && rep && (
              <p className="mt-2.5 text-xs text-subtle">
                Team average afterwards: {fmt(Math.round(avgAfter))} leads per rep.
              </p>
            )}
          </section>
        )}

        {mode === 'ids' && known.length > 0 && <SelectionSummary leads={known} total={count} />}
      </div>
    </Dialog>
  );
}

function Notice({ tone, icon, children }: { tone: 'danger' | 'warning' | 'info'; icon: ReactNode; children: ReactNode }) {
  const tones = {
    danger: 'bg-danger-soft text-danger',
    warning: 'bg-warning-soft text-warning',
    info: 'bg-info-soft text-info',
  };
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={cn('flex gap-2 rounded-lg px-3 py-2 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0', tones[tone])}>
      {icon}
      <p>{children}</p>
    </div>
  );
}

export interface LoadRowData {
  key: string;
  name: string;
  before: number;
  after: number;
  pool?: boolean;
  capped?: boolean;
  highlight?: boolean;
  /** Own bar scale (the pool is far larger than any rep's book). */
  scale?: number;
}

/** One load bar: the kept part solid, what is added lighter, what leaves as a dashed outline. */
export function LoadRow({ row, scaleMax }: { row: LoadRowData; scaleMax: number }) {
  const { before, after } = row;
  const scale = Math.max(1, row.scale ?? scaleMax);
  const pct = (n: number) => `${(Math.max(0, n) / scale) * 100}%`;
  const kept = Math.min(before, after);
  const diff = after - before;
  return (
    <li className="flex items-center gap-3">
      {row.pool ? (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted"><Inbox className="size-3.5" aria-hidden /></span>
      ) : (
        <Avatar name={row.name} size={28} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className={cn('truncate', row.highlight ? 'font-medium text-fg' : 'text-muted')}>{row.name}</span>
          <span className="shrink-0 text-muted tabular">
            {fmt(before)} → <span className="font-semibold text-fg">{fmt(after)}{row.capped && diff > 0 ? '+' : ''}</span>
            {diff !== 0 && (
              <span className={cn('ml-1.5 text-xs font-medium', row.pool ? 'text-muted' : diff > 0 ? 'text-success' : 'text-warning')}>
                {diff > 0 ? '+' : '−'}{fmt(Math.abs(diff))}{row.capped ? '+' : ''}
              </span>
            )}
          </span>
        </div>
        <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
          <span className={cn('h-full', row.pool ? 'bg-muted/60' : 'bg-accent')} style={{ width: pct(kept) }} />
          {diff > 0 && <span className="h-full bg-accent/40 bg-[repeating-linear-gradient(135deg,transparent_0_3px,color-mix(in_srgb,var(--c-surface)_35%,transparent)_3px_6px)]" style={{ width: pct(diff) }} />}
          {diff < 0 && <span className="h-full rounded-r-full border border-dashed border-border-strong" style={{ width: pct(-diff) }} />}
        </div>
      </div>
    </li>
  );
}

function SelectionSummary({ leads, total }: { leads: LeadSummary[]; total: number }) {
  const segments = segmentBreakdown(leads);
  const counties = new Map<string, number>();
  for (const l of leads) if (l.countyFips) counties.set(l.countyFips, (counties.get(l.countyFips) ?? 0) + 1);
  const topCounties = [...counties.entries()].sort((a, b) => b[1] - a[1]);
  const scored = leads.filter((l) => l.priorityScore != null);
  const avg = scored.length ? scored.reduce((n, l) => n + (l.priorityScore ?? 0), 0) / scored.length : null;
  const shown = [...leads].sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0)).slice(0, 4);
  const more = total - shown.length;
  return (
    <section aria-label="What you're assigning" className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        {segments.map((s) => (
          <Badge key={s.label} variant={s.segment ? segmentVariant(s.segment) : 'neutral'}>{s.count} {s.label}</Badge>
        ))}
        {avg !== null && <span className="ml-auto text-xs text-muted">Avg. priority <span className="font-semibold text-fg tabular">{Math.round(avg)}</span></span>}
      </div>
      <ul className="divide-y divide-border">
        {shown.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
            <span className="min-w-0 truncate text-fg">{l.businessName}</span>
            <span className="shrink-0 text-xs text-muted tabular">
              {l.countyFips ? countyPlace(l.countyFips) : l.postalCode ?? ''}{l.priorityScore != null ? ` · ${Math.round(l.priorityScore)}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {(more > 0 || topCounties.length > 1) && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted">
          {more > 0 && <>and {plural(more, 'more lead')}. </>}
          {topCounties.length > 1 && <>Across {topCounties.slice(0, 3).map(([f]) => countyPlace(f)).join(', ')}{topCounties.length > 3 ? ` and ${topCounties.length - 3} more` : ''}.</>}
        </div>
      )}
    </section>
  );
}
