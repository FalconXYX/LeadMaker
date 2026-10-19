import { useNotificationPreferences } from '@/api/queries';
import type { Role } from '@/api/types';
import { Button, Dialog, ErrorState, Skeleton, Toggle } from '@/components/ui';
import { cn } from '@/lib/cn';
import { TYPE_META, typesFor } from './meta';
import { useSavePreference } from './queries';
import { prefsOf } from './types';

/** Per-type on/off switches; each change saves at once (PUT /api/notifications/preferences). */
export function PreferencesDialog({ open, onClose, role }: { open: boolean; onClose: () => void; role: Role }) {
  const prefs = useNotificationPreferences({ enabled: open });
  const save = useSavePreference();
  const enabled = prefsOf(prefs.data);
  const types = typesFor(role);
  const offCount = types.filter((t) => !enabled.get(t)).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Notification settings"
      description="Choose what LeadMaker tells you about. Changes save automatically."
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      {prefs.isLoading ? (
        <ul className="divide-y divide-border" aria-busy="true" aria-label="Loading settings">
          {types.map((t) => (
            <li key={t} className="flex items-start gap-3 py-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-3 w-full" /></div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </li>
          ))}
        </ul>
      ) : prefs.isError ? (
        <ErrorState message="Your notification settings couldn't load." onRetry={() => void prefs.refetch()} className="py-6" />
      ) : (
        <>
          <ul className="-mt-1 divide-y divide-border">
            {types.map((t) => {
              const meta = TYPE_META[t];
              const on = enabled.get(t) ?? true;
              const Icon = meta.icon;
              const descId = `pref-desc-${t}`;
              return (
                <li key={t} className="flex items-start gap-3 py-3">
                  <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', on ? meta.tone : 'bg-surface-2 text-subtle')}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm font-medium', on ? 'text-fg' : 'text-muted')}>{meta.label}</p>
                    <p id={descId} className="mt-0.5 text-xs text-muted">{meta.description}</p>
                  </div>
                  <div className="pt-1">
                    <Toggle
                      checked={on}
                      onCheckedChange={(v) => save.mutate({ type: t, enabled: v })}
                      aria-label={meta.label}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-subtle" aria-live="polite">
            {save.isPending ? 'Saving…' : offCount ? `${offCount} turned off. You can turn them back on any time.` : 'You get every notification type.'}
          </p>
        </>
      )}
    </Dialog>
  );
}
