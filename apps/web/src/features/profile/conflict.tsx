// Optimistic-locking writes. A write sends the version the user started from; on 409 we compare the
// server's current value with the value the user started from:
//   - unchanged: only other parts of the record moved, so nothing of theirs is overwritten -> retry once
//     with the new version, silently;
//   - changed: show the conflict dialog (their value, who, when) with Use theirs / Overwrite.
import { useState } from 'react';
import { VersionConflictError, isRecord } from '@/api/client';
import type { UserRef } from '@/api/types';
import { Button, Dialog } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import { formatValue, sameValue } from './lib';

export type WriteResult = 'saved' | 'conflict' | 'error';

interface Conflict {
  label: string;
  mode: 'save' | 'revert';
  theirs: unknown;
  mine: unknown;
  changedBy: UserRef | null;
  changedByType: string | null;
  changedAt: string | null;
  version: number;
  attempt: (version: number) => Promise<unknown>;
  theirsFrom?: (current: Record<string, unknown>) => unknown;
  onDone: () => void;
}

export interface VersionedWrite {
  label: string;
  mode?: 'save' | 'revert';
  /** The value the user started editing from (what they saw). */
  base: unknown;
  /** What they want it to become (for the dialog). */
  mine: unknown;
  /** The version they read. */
  version: number;
  attempt: (version: number) => Promise<unknown>;
  /** Their value from the 409 body's `current` (default: current.value). */
  theirsFrom?: (current: Record<string, unknown>) => unknown;
  /** Called when the write finally lands or the user takes theirs (close the editor). */
  onDone: () => void;
}

export function useVersionedWrite() {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (w: VersionedWrite): Promise<WriteResult> => {
    setBusy(true);
    try {
      let version = w.version;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await w.attempt(version);
          w.onDone();
          return 'saved';
        } catch (e) {
          if (!(e instanceof VersionConflictError)) return 'error';
          const current = isRecord(e.current) ? e.current : {};
          const theirs = w.theirsFrom ? w.theirsFrom(current) : current.value;
          const next = typeof current.version === 'number' ? current.version : null;
          if (attempt === 0 && next !== null && sameValue(theirs, w.base)) {
            version = next;
            continue;
          }
          const body = isRecord(e.body) ? e.body : {};
          setConflict({
            label: w.label,
            mode: w.mode ?? 'save',
            theirs,
            mine: w.mine,
            changedBy: e.changedBy,
            changedByType: typeof body.changedByType === 'string' ? body.changedByType : null,
            changedAt: e.changedAt,
            version: next ?? version,
            attempt: w.attempt,
            theirsFrom: w.theirsFrom,
            onDone: w.onDone,
          });
          return 'conflict';
        }
      }
      return 'error';
    } finally {
      setBusy(false);
    }
  };

  const dialog = conflict ? (
    <ConflictDialog
      conflict={conflict}
      onCancel={() => setConflict(null)}
      onUseTheirs={() => {
        setConflict(null);
        conflict.onDone();
      }}
      onOverwrite={async () => {
        try {
          await conflict.attempt(conflict.version);
          setConflict(null);
          conflict.onDone();
        } catch (e) {
          if (e instanceof VersionConflictError) {
            // It moved again while the dialog was open: show the newest value.
            const current = isRecord(e.current) ? e.current : {};
            setConflict({
              ...conflict,
              theirs: conflict.theirsFrom ? conflict.theirsFrom(current) : current.value,
              changedBy: e.changedBy,
              changedAt: e.changedAt,
              version: typeof current.version === 'number' ? current.version : conflict.version,
            });
          } else {
            setConflict(null);
          }
        }
      }}
    />
  ) : null;

  return { run, busy, dialog, hasConflict: !!conflict };
}

function ConflictDialog({
  conflict, onCancel, onUseTheirs, onOverwrite,
}: { conflict: Conflict; onCancel: () => void; onUseTheirs: () => void; onOverwrite: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const who = conflict.changedBy?.name
    ?? (conflict.changedByType === 'pipeline' ? 'The data pipeline' : 'Someone else');
  const when = conflict.changedAt ? formatRelative(conflict.changedAt) : null;
  const revert = conflict.mode === 'revert';
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`${conflict.label} changed while you were editing`}
      description={`${who} changed this lead${when ? ` ${when}` : ''}. Choose which value to keep.`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>Keep editing</Button>
          <Button onClick={onUseTheirs} disabled={saving}>Use theirs</Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onOverwrite();
              } finally {
                setSaving(false);
              }
            }}
          >
            {revert ? 'Revert anyway' : 'Overwrite with mine'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs font-medium text-muted">Their value</p>
          <p className="mt-1 font-medium break-words text-fg" data-testid="conflict-theirs">{formatValue(conflict.theirs)}</p>
          <p className="mt-1.5 text-xs text-subtle">
            {who}
            {conflict.changedAt && <> · <time dateTime={conflict.changedAt}>{formatDateTime(conflict.changedAt)}</time></>}
          </p>
        </div>
        <div className="rounded-lg border border-accent/40 bg-accent-soft p-3">
          <p className="text-xs font-medium text-accent">{revert ? 'Your change' : 'Your value'}</p>
          <p className="mt-1 font-medium break-words text-fg" data-testid="conflict-mine">
            {revert ? `Revert to source: ${formatValue(conflict.mine)}` : formatValue(conflict.mine)}
          </p>
          <p className="mt-1.5 text-xs text-subtle">Not saved yet</p>
        </div>
      </div>
    </Dialog>
  );
}
