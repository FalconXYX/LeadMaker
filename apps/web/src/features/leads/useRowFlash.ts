// Live-update highlight: when a refetch (after an SSE invalidation) changes a lead that is already on
// screen, its row flashes for a second and fades out. The user's own optimistic edits don't flash.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeadSummary } from '@/api/types';

export type FlashState = 'on' | 'fading';

const FLASH_MS = 1000;
const FADE_MS = 900;
const LOCAL_EDIT_MS = 5000;

/** What a visible change looks like: anything the row shows. */
export function rowSignature(l: LeadSummary): string {
  return [
    l.version, l.lastChangeAt, l.priorityScore, l.segment, l.tier, l.rating, l.reviewCount, l.updatedInLastPoll,
    l.mine?.checked, l.mine?.serviced, l.team?.checked, l.team?.serviced, l.assignedRep?.id ?? '-', l.accountStatus,
    l.businessName, (l.customTags ?? []).map((t) => t.id).join(','),
  ].join('|');
}

export function useRowFlash(items: readonly LeadSummary[]): {
  flash: ReadonlyMap<string, FlashState>;
  /** Mark a lead as edited here (its next change won't flash). */
  markLocalEdit: (leadId: string) => void;
} {
  const seen = useRef(new Map<string, string>());
  const local = useRef(new Map<string, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [flash, setFlash] = useState<ReadonlyMap<string, FlashState>>(new Map());

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  };

  useEffect(() => {
    const now = Date.now();
    const changed: string[] = [];
    for (const lead of items) {
      const sig = rowSignature(lead);
      const prev = seen.current.get(lead.id);
      const localAt = local.current.get(lead.id);
      if (prev !== undefined && prev !== sig && !(localAt && now - localAt < LOCAL_EDIT_MS)) changed.push(lead.id);
      seen.current.set(lead.id, sig);
    }
    if (!changed.length) return;
    setFlash((m) => {
      const next = new Map(m);
      changed.forEach((id) => next.set(id, 'on'));
      return next;
    });
    later(() => {
      setFlash((m) => {
        const next = new Map(m);
        changed.forEach((id) => next.get(id) === 'on' && next.set(id, 'fading'));
        return next;
      });
      later(() => setFlash((m) => {
        const next = new Map(m);
        changed.forEach((id) => next.get(id) === 'fading' && next.delete(id));
        return next;
      }), FADE_MS);
    }, FLASH_MS);
  }, [items]);

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const markLocalEdit = useCallback((leadId: string) => {
    local.current.set(leadId, Date.now());
  }, []);

  return { flash, markLocalEdit };
}
