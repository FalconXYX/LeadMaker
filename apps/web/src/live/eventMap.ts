// SSE event -> TanStack Query keys to invalidate. Pure, so it is unit-tested.
import type { QueryKey } from '@tanstack/react-query';
import { qk } from '@/api/queries';
import type { EventType } from '@/api/types';

export const LEAD_EVENT_TYPES = [
  'lead.updated', 'lead.allocated', 'note.added', 'state.changed', 'override.set', 'tags.changed',
  'pipeline.run_completed',
] as const satisfies readonly EventType[];

// Fails the typecheck when packages/shared adds an event type this list does not handle.
type Unhandled = Exclude<EventType, (typeof LEAD_EVENT_TYPES)[number]>;
const _exhaustive: Unhandled extends never ? true : Unhandled = true;
void _exhaustive;

export const NOTIFICATION_EVENT = 'notification.created';

/** Every named SSE event the client listens for (EventSource only delivers named events to listeners). */
export const STREAM_EVENT_TYPES = [...LEAD_EVENT_TYPES, NOTIFICATION_EVENT] as const;
export type LiveEventType = (typeof STREAM_EVENT_TYPES)[number];

export interface LiveEvent {
  /** Stream id (Redis stream id), used as Last-Event-ID. */
  id: string;
  type: LiveEventType;
  companyIds: string[];
  payload: Record<string, unknown>;
  /** The parsed `data` as sent. */
  data: unknown;
  /**
   * Who acted, for display (payload.actor_name): the user's name for crm-write events, 'system' for notifications;
   * null on pipeline events and older entries. Optional so hand-built events (tests) need not set it.
   */
  actorName?: string | null;
}

/** payload.actor_name when it is a usable name, else null. */
export function actorNameOf(event: Pick<LiveEvent, 'payload'> & { actorName?: string | null }): string | null {
  const v = event.actorName ?? event.payload.actor_name;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Normalises a raw SSE message: LeadEvent {type, company_id, payload} or a flat notification object. */
export function parseLiveEvent(type: string, id: string, rawData: string): LiveEvent | null {
  if (!(STREAM_EVENT_TYPES as readonly string[]).includes(type)) return null;
  let data: unknown;
  try {
    data = JSON.parse(rawData);
  } catch {
    return null;
  }
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const payload = (typeof d.payload === 'object' && d.payload !== null ? d.payload : d) as Record<string, unknown>;
  const ids = [d.company_id, payload.company_id, ...(Array.isArray(payload.company_ids) ? payload.company_ids : [])];
  const companyIds = [...new Set(ids.filter((v): v is string => typeof v === 'string' && v.length > 0))];
  return { id, type: type as LiveEventType, companyIds, payload, data, actorName: actorNameOf({ payload }) };
}

/** The queries an event makes stale. */
export function invalidationsFor(event: Pick<LiveEvent, 'type' | 'companyIds'> & { payload?: Record<string, unknown> }): QueryKey[] {
  const perLead = event.companyIds.flatMap((id) => [qk.leads.detail(id), qk.leads.activityAll(id)]);
  switch (event.type) {
    case 'lead.updated': {
      // A new AI insight changes only the profile (lists carry no insight and the version doesn't move).
      if (isInsightsOnly(event.payload)) return event.companyIds.map((id) => qk.leads.detail(id));
      // crm-write's task writes are lead.updated with fields ['tasks'].
      const fields = event.payload?.fields;
      const tasks = Array.isArray(fields) && fields.includes('tasks') ? [qk.tasks] : [];
      return [...perLead, qk.leads.lists, qk.kpis, ...tasks];
    }
    case 'note.added':
    case 'state.changed':
    case 'override.set':
      return [...perLead, qk.leads.lists, qk.kpis];
    case 'tags.changed':
      return [...perLead, qk.leads.lists, qk.kpis, qk.customTags];
    case 'lead.allocated':
      // Reassigning a lead moves its open tasks to the new rep.
      return [...perLead, qk.leads.lists, qk.kpis, qk.allocationsAll, qk.usersAll, qk.tasks];
    case 'pipeline.run_completed':
      return [qk.leads.lists, qk.kpis, qk.allocationsAll, qk.signalsAll, qk.customFieldKeys, qk.territoryBriefAll];
    case 'notification.created':
      return [qk.notifications.all];
  }
}

/**
 * The batch insights job's event: lead.updated whose fields are exactly ['insights']. It refreshes the profile
 * silently (no "Updated by" toast, no highlight) and touches nothing else.
 */
export function isInsightsOnly(payload: Record<string, unknown> | undefined): boolean {
  const fields = payload?.fields;
  return Array.isArray(fields) && fields.length === 1 && fields[0] === 'insights';
}

/** After a reconnect, events may have been missed beyond the replay window: refresh the broad views. */
export const RESYNC_KEYS: QueryKey[] = [qk.leads.all, qk.kpis, qk.notifications.all, qk.allocationsAll, qk.tasks];

/** True when the signed-in user caused the event (skip "X changed this" toasts for your own writes). */
export function isOwnEvent(event: Pick<LiveEvent, 'payload'>, userId: string | undefined): boolean {
  return !!userId && event.payload.actor_id === userId;
}
