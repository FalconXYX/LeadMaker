// Manager admin: where LeadMaker sources leads (areas + schedules + Run now) and the recent refresh runs.
// Route /admin (RequireManager).
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, useMediaQuery, useToast } from '@/components/ui';
import { Page, PageHeader } from '@/layout/PageHeader';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useRuns, useTerritories, useTerritoryActions } from './api';
import { AreaDialog } from './AreaDialog';
import { STATUS_LABELS, areaText, isActive, territoryName } from './lib';
import { RunsSection } from './RunsSection';
import { TerritoriesSection, type LiveRun } from './TerritoriesSection';
import type { Run, Territory, TerritoryInput } from './types';

/** Placeholder job id between pressing Run now and the server answering. */
const STARTING = '';

export function AdminPage() {
  useDocumentTitle('Admin');
  const toast = useToast();
  const isPhone = useMediaQuery('(max-width: 767px)');
  const actions = useTerritoryActions();

  // Runs started from this page: area id -> job id, so the row follows that exact run.
  const [started, setStarted] = useState<Record<string, string>>({});
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Territory | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Territory | null>(null);

  // Two-pass: the runs list decides what is live, which decides how fast both lists poll.
  const [fast, setFast] = useState(false);
  const territories = useTerritories(fast);
  const runs = useRuns(fast);
  const live = useMemo(() => liveRuns(territories.data ?? [], runs.data ?? [], started), [territories.data, runs.data, started]);
  const anyActive = Object.values(live).some((r) => isActive(r?.status)) || (runs.data ?? []).some((r) => isActive(r.status));
  useEffect(() => setFast(anyActive), [anyActive]);

  // A clock for running durations, ticking only while something runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  const runNow = (t: Territory) => {
    setStarted((s) => ({ ...s, [t.id]: STARTING }));
    actions.run.mutate(t, {
      onSuccess: ({ jobId }) => {
        setStarted((s) => ({ ...s, [t.id]: jobId }));
        toast.info(`Looking for contractors around ${t.zip}`, 'Queued. This page shows the run as it goes.');
      },
      onError: () => setStarted(({ [t.id]: _gone, ...rest }) => rest),
    });
  };

  const toggle = (t: Territory, enabled: boolean) => {
    setToggling((s) => new Set(s).add(t.id));
    actions.setEnabled.mutate({ id: t.id, enabled }, {
      onSettled: () => setToggling((s) => {
        const next = new Set(s);
        next.delete(t.id);
        return next;
      }),
    });
  };

  const save = async (input: TerritoryInput, patch: Partial<TerritoryInput> | null) => {
    if (editing && editing !== 'new' && patch) {
      const t = await actions.update.mutateAsync({ id: editing.id, patch });
      toast.success('Area saved', `${territoryName(t)}: ${areaText(t.zip, t.radiusMiles)}.`);
    } else {
      await actions.create.mutateAsync(input);
    }
  };

  const announce = useMemo(() => {
    const items = (territories.data ?? []).filter((t) => started[t.id] !== undefined && live[t.id]);
    return items.map((t) => `${territoryName(t)}: ${STATUS_LABELS[live[t.id]!.status]}`).join('. ');
  }, [territories.data, started, live]);

  return (
    <Page>
      <PageHeader title="Admin" description="Choose where LeadMaker finds new contractors and keep an eye on each refresh." />
      <p className="sr-only" aria-live="polite">{announce}</p>

      <div className="space-y-10 lg:space-y-12">
        <TerritoriesSection
          territories={territories.data}
          isLoading={territories.isLoading}
          error={territories.error}
          onRetry={() => void territories.refetch()}
          live={live}
          isPhone={isPhone}
          onAdd={() => setEditing('new')}
          onEdit={setEditing}
          onDelete={setDeleting}
          onRun={runNow}
          onToggle={toggle}
          toggling={toggling}
        />
        <RunsSection
          runs={runs.data}
          territories={territories.data}
          isLoading={runs.isLoading}
          isFetching={runs.isFetching}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          isPhone={isPhone}
          now={now}
        />
      </div>

      <AreaDialog
        open={editing !== null}
        territory={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSave={save}
      />

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        size="sm"
        title="Delete this area?"
        description={deleting && (
          <>LeadMaker stops looking for contractors around <strong className="font-medium text-fg">{areaText(deleting.zip, deleting.radiusMiles)}</strong>. Leads it already found stay in LeadMaker.</>
        )}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={actions.remove.isPending}
              onClick={() => {
                if (!deleting) return;
                actions.remove.mutate(deleting, { onSuccess: () => setDeleting(null) });
              }}
            >
              Delete area
            </Button>
          </>
        )}
      />
    </Page>
  );
}

/**
 * Each area's latest run: the one started from this page (queued until the server lists it), else the
 * area's last run, refreshed from the runs list when it is there (that list polls faster).
 */
export function liveRuns(territories: Territory[], runs: Run[], started: Record<string, string>): Record<string, LiveRun | null> {
  const byId = new Map(runs.map((r) => [r.jobId, r]));
  const fromRun = (r: Run): LiveRun => ({ status: r.status, at: r.finishedAt ?? r.startedAt ?? r.createdAt ?? null });
  const out: Record<string, LiveRun | null> = {};
  for (const t of territories) {
    const mine = started[t.id];
    const last = t.lastRun;
    if (mine !== undefined) {
      const r = mine ? byId.get(mine) : undefined;
      out[t.id] = r ? fromRun(r)
        : last && mine && last.jobId === mine ? { status: last.status, at: last.finishedAt }
        : { status: 'queued', at: null };
    } else if (last) {
      const r = byId.get(last.jobId);
      out[t.id] = r ? fromRun(r) : { status: last.status, at: last.finishedAt };
    } else {
      out[t.id] = null;
    }
  }
  return out;
}
