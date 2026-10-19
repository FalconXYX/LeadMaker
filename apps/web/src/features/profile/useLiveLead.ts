// Live collaboration on one lead: when someone else changes it, the global event stream refetches the
// profile; here we wait for that new data, flash what changed and toast "Updated by <name>".
// Open editors keep their drafts (their state is local); a save then runs the conflict flow.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { qk } from '@/api/queries';
import type { LeadProfile } from '@/api/types';
import { useToast } from '@/components/ui';
import { actorNameOf, isInsightsOnly, isOwnEvent } from '@/live/eventMap';
import { useLiveEvent } from '@/live/useEventStream';
import { applyTagEvent, describeLiveEvent, knownUsers, profileChanges } from './lib';

interface PendingEvent {
  at: number;
  type: string;
  actorId: string | null;
  /** payload.actor_name: the writer's name as crm-write recorded it. */
  actorName: string | null;
  actorType: string;
  payload: Record<string, unknown>;
}

const HIGHLIGHT_MS = 2600;
const FALLBACK_MS = 4000;
const STALE_MS = 15_000;
const EMPTY = new Set<string>();

export function useLiveLead(leadId: string, profile: LeadProfile | undefined, meId: string | undefined): ReadonlySet<string> {
  const toast = useToast();
  const qc = useQueryClient();
  const [highlights, setHighlights] = useState<ReadonlySet<string>>(EMPTY);
  const pending = useRef<PendingEvent | null>(null);
  const prev = useRef<LeadProfile | undefined>(profile);
  const fallback = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clear = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => {
    clearTimeout(fallback.current);
    clearTimeout(clear.current);
  }, []);

  const announce = (p: LeadProfile | undefined, ev: PendingEvent) => {
    // The event names its writer; the profile's known users cover older events; "a teammate" is the last resort.
    const name = ev.actorType === 'pipeline'
      ? 'the data pipeline'
      : ev.actorName ?? (ev.actorId && p ? knownUsers(p).get(ev.actorId) : undefined) ?? 'a teammate';
    toast({ id: `live-${leadId}`, title: `Updated by ${name}`, description: describeLiveEvent(ev.type, ev.payload), variant: 'info' });
  };

  useLiveEvent('*', (e) => {
    const own = isOwnEvent(e, meId);
    const about = e.companyIds.includes(leadId);
    if (e.type === 'notification.created' || (!about && e.type !== 'tags.changed')) return;
    // A fresh AI insight: the app-wide stream refetches the profile; it appears quietly, without a toast or flash.
    if (e.type === 'lead.updated' && isInsightsOnly(e.payload)) return;
    if (!own && about) {
      pending.current = {
        at: Date.now(),
        type: e.type,
        actorId: typeof e.payload.actor_id === 'string' ? e.payload.actor_id : null,
        actorName: actorNameOf(e),
        actorType: typeof e.payload.actor_type === 'string' ? e.payload.actor_type : 'user',
        payload: e.payload,
      };
    }
    // A tag renamed or deleted anywhere (the per-lead event, or the tag-level one with no lead) shows on the chips
    // at once; the refetch the event also triggers then confirms it.
    if (e.type === 'tags.changed') {
      qc.setQueryData<LeadProfile>(qk.leads.detail(leadId), (p) => (p ? applyTagEvent(p, e.payload) : p));
    }
    if (own || !about) return;
    // If the refetch shows nothing new (or fails, e.g. the lead left this user's territory), still say so.
    clearTimeout(fallback.current);
    fallback.current = setTimeout(() => {
      if (pending.current) announce(prev.current, pending.current);
      pending.current = null;
    }, FALLBACK_MS);
  });

  useEffect(() => {
    const before = prev.current;
    prev.current = profile;
    const ev = pending.current;
    if (!before || !profile || before === profile || !ev) return;
    if (Date.now() - ev.at > STALE_MS) {
      pending.current = null;
      return;
    }
    pending.current = null;
    clearTimeout(fallback.current);
    const changes = profileChanges(before, profile);
    if (changes.size) {
      setHighlights(changes);
      clearTimeout(clear.current);
      clear.current = setTimeout(() => setHighlights(EMPTY), HIGHLIGHT_MS);
    }
    announce(profile, ev);
  }, [profile]); // announce only reads leadId and the toast API


  return highlights;
}
