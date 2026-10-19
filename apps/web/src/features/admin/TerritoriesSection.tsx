// "Lead sourcing": the areas LeadMaker searches, their schedule and on/off switch, last / next run, Run now.
import { LoaderCircle, MapPin, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import {
  Button, Card, EmptyState, ErrorState, IconButton, Skeleton, SkeletonRows, TBody, TD, TH, THead, TR, Table, Toggle,
} from '@/components/ui';
import { CardStat, SectionHeading, StatusChip, When } from './parts';
import { STATUS_LABELS, areaText, isActive, scheduleLabel, territoryName } from './lib';
import type { RunStatus, Territory } from './types';

/** What the row shows as its latest run: the one just started here, else the server's last run. */
export interface LiveRun {
  status: RunStatus;
  at: string | null;
}

export interface TerritoriesSectionProps {
  territories: Territory[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  live: Record<string, LiveRun | null>;
  isPhone: boolean;
  onAdd: () => void;
  onEdit: (t: Territory) => void;
  onDelete: (t: Territory) => void;
  onRun: (t: Territory) => void;
  onToggle: (t: Territory, enabled: boolean) => void;
  /** Area ids whose on/off change is still saving. */
  toggling: ReadonlySet<string>;
}

export function TerritoriesSection(p: TerritoriesSectionProps) {
  const list = p.territories;
  return (
    <section aria-labelledby="sourcing-heading">
      <SectionHeading
        id="sourcing-heading"
        title="Lead sourcing"
        subtitle="Where LeadMaker looks for contractors"
        action={<Button variant="primary" leftIcon={<Plus className="size-4" aria-hidden />} onClick={p.onAdd}>Add area</Button>}
      />
      <Card className="overflow-hidden">
        {p.error && !list ? (
          <ErrorState message={errorMessage(p.error)} onRetry={p.onRetry} />
        ) : list && !list.length ? (
          <EmptyState
            icon={<MapPin />}
            title="No areas yet"
            description="Add a ZIP code and LeadMaker will find roofing contractors around it, tag them and write AI insights."
            action={<Button variant="primary" leftIcon={<Plus className="size-4" aria-hidden />} onClick={p.onAdd}>Add area</Button>}
          />
        ) : p.isPhone ? (
          <PhoneList {...p} />
        ) : (
          <Table aria-label="Lead sourcing areas" aria-busy={p.isLoading || undefined}>
            <THead>
              <tr>
                <TH className="pl-5 sm:pl-6">Name</TH>
                <TH>ZIP + radius</TH>
                <TH hint="Also searched with the same radius">Extra ZIPs</TH>
                <TH>Schedule</TH>
                <TH>On</TH>
                <TH>Last run</TH>
                <TH>Next run</TH>
                <TH align="right" className="pr-5 sm:pr-6"><span className="sr-only">Actions</span></TH>
              </tr>
            </THead>
            <TBody>
              {!list ? <SkeletonRows rows={2} columns={8} /> : list.map((t) => <AreaRow key={t.id} t={t} {...p} />)}
            </TBody>
          </Table>
        )}
      </Card>
    </section>
  );
}

type RowProps = TerritoriesSectionProps & { t: Territory };

function AreaRow({ t, live, onEdit, onDelete, onRun, onToggle, toggling }: RowProps) {
  const name = territoryName(t);
  const run = live[t.id] ?? null;
  return (
    <TR>
      <TD className="pl-5 font-medium text-fg sm:pl-6">{name}</TD>
      <TD className="whitespace-nowrap tabular">{areaText(t.zip, t.radiusMiles)}</TD>
      <TD><ExtraZips zips={t.alsoZips} /></TD>
      <TD className="whitespace-nowrap">{scheduleLabel(t.everyHours)}</TD>
      <TD>
        <Toggle size="sm" checked={t.enabled} disabled={toggling.has(t.id)} onCheckedChange={(v) => onToggle(t, v)} aria-label={`${name} turned on`} />
      </TD>
      <TD><LastRun run={run} /></TD>
      <TD className="whitespace-nowrap"><NextRun t={t} /></TD>
      <TD align="right" className="pr-5 sm:pr-6">
        <div className="flex items-center justify-end gap-1">
          <RunButton name={name} run={run} onRun={() => onRun(t)} />
          <IconButton size="sm" label={`Edit ${name}`} icon={<Pencil />} onClick={() => onEdit(t)} />
          <IconButton size="sm" label={`Delete ${name}`} icon={<Trash2 />} onClick={() => onDelete(t)} />
        </div>
      </TD>
    </TR>
  );
}

function PhoneList({ territories, live, onEdit, onDelete, onRun, onToggle, toggling }: TerritoriesSectionProps) {
  if (!territories) {
    return (
      <div className="space-y-3 p-4" aria-hidden>
        {Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
    );
  }
  return (
    <ul aria-label="Lead sourcing areas" className="divide-y divide-divider">
      {territories.map((t) => {
        const name = territoryName(t);
        const run = live[t.id] ?? null;
        return (
          <li key={t.id} className="space-y-3.5 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-fg">{name}</p>
                <p className="mt-0.5 text-sm text-muted tabular">{areaText(t.zip, t.radiusMiles)} · {scheduleLabel(t.everyHours)}</p>
              </div>
              <Toggle size="sm" checked={t.enabled} disabled={toggling.has(t.id)} onCheckedChange={(v) => onToggle(t, v)} aria-label={`${name} turned on`} className="pt-1" />
            </div>
            <dl className="grid grid-cols-2 gap-3">
              <CardStat label="Last run"><LastRun run={run} /></CardStat>
              <CardStat label="Next run"><NextRun t={t} /></CardStat>
              {t.alsoZips.length > 0 && <div className="col-span-2"><CardStat label="Extra ZIPs"><ExtraZips zips={t.alsoZips} all /></CardStat></div>}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <RunButton name={name} run={run} onRun={() => onRun(t)} />
              <Button size="sm" variant="ghost" leftIcon={<Pencil className="size-4" aria-hidden />} onClick={() => onEdit(t)} aria-label={`Edit ${name}`}>Edit</Button>
              <Button size="sm" variant="ghost" leftIcon={<Trash2 className="size-4" aria-hidden />} onClick={() => onDelete(t)} aria-label={`Delete ${name}`}>Delete</Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ExtraZips({ zips, all }: { zips: string[]; all?: boolean }) {
  if (!zips.length) return <span className="text-subtle">—</span>;
  const shown = all ? zips : zips.slice(0, 3);
  const more = zips.length - shown.length;
  return (
    <span className="tabular" title={more ? zips.join(', ') : undefined}>
      {shown.join(', ')}
      {more > 0 && <span className="text-muted"> +{more} more</span>}
    </span>
  );
}

function LastRun({ run }: { run: LiveRun | null }) {
  if (!run) return <span className="text-subtle">Never run</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusChip status={run.status} />
      {run.at && <When iso={run.at} className="text-xs whitespace-nowrap text-muted" />}
    </span>
  );
}

function NextRun({ t }: { t: Territory }) {
  if (t.everyHours == null) return <span className="text-subtle">Manual only</span>;
  if (!t.enabled) return <span className="text-subtle">Paused</span>;
  return <When iso={t.nextRunAt} fallback="Soon" />;
}

/**
 * Run now; while the run is queued or running it shows that status instead. The button stays focusable
 * (aria-disabled, not disabled) so keyboard focus is not lost when it changes.
 */
function RunButton({ name, run, onRun }: { name: string; run: LiveRun | null; onRun: () => void }) {
  const label = run && isActive(run.status) ? STATUS_LABELS[run.status] : null;
  const busy = !!label;
  return (
    <Button
      size="sm"
      variant={busy ? 'subtle' : 'secondary'}
      aria-disabled={busy || undefined}
      aria-label={label ? `${name}: ${label}` : `Run now: ${name}`}
      leftIcon={label ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
      onClick={busy ? undefined : onRun}
      className={busy ? 'cursor-default' : undefined}
    >
      {label ?? 'Run now'}
    </Button>
  );
}
