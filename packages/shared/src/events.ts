// Outbox events (outbox_events table -> Redis Stream 'events'). The DB CHECKs event_type against
// EVENT_TYPES and requires payload.actor_type.
export const EVENTS_STREAM = 'events';

/** Events about leads and pipeline runs: what LeadEvent.type carries and the caches react to. */
export const LEAD_EVENT_TYPES = [
  'lead.updated',
  'lead.allocated',
  'note.added',
  'state.changed',
  'override.set',
  'tags.changed',
  'pipeline.run_completed',
] as const;
export type EventType = (typeof LEAD_EVENT_TYPES)[number];

/** Written by the notifier, one per notification (NotificationCreatedPayload). It names no lead: only payload.user_id gets it. */
export const NOTIFICATION_CREATED = 'notification.created';

/** Every outbox event type: the lead events plus notification.created (in no lead-event list below). */
export const EVENT_TYPES = [...LEAD_EVENT_TYPES, NOTIFICATION_CREATED] as const;
export type OutboxEventType = (typeof EVENT_TYPES)[number];

export const ACTOR_TYPES = ['user', 'pipeline', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface EventPayload {
  actor_type: ActorType;
  actor_id: string | null;
  /** Who acted, for display: the user's name (crm-write) or 'system' (notifier); absent on pipeline events. */
  actor_name?: string;
  company_id?: string;
  company_ids?: string[];
  version?: number;
  /** Allocation after the change (lead.allocated), so live updates reach the new owner. */
  assigned_rep_id?: string | null;
  /** Allocation before the change (lead.allocated), so the previous owner sees the lead leave. */
  previous_rep_id?: string | null;
  [key: string]: unknown;
}

/** One relayed event, as the relay writes it to the stream and the gateway forwards it over SSE. */
export interface LeadEvent {
  id: string;
  type: EventType;
  company_id: string | null;
  payload: EventPayload;
  created_at: string;
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (LEAD_EVENT_TYPES as readonly string[]).includes(value);
}

export function isOutboxEventType(value: unknown): value is OutboxEventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

/** Every company an event touches (company_id plus payload.company_id / company_ids), de-duplicated. */
export function eventCompanyIds(event: Pick<LeadEvent, 'company_id' | 'payload'>): string[] {
  const ids = [event.company_id, event.payload?.company_id, ...(event.payload?.company_ids ?? [])];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** Events that change what a lead list or profile shows (all of them; a completed run sets updated_in_last_poll). */
export const LEAD_CHANGING_EVENTS: readonly EventType[] = [
  'lead.updated', 'lead.allocated', 'note.added', 'state.changed', 'override.set', 'tags.changed',
  'pipeline.run_completed',
];

/** Events that can change a lead list page; a note shows only on the profile (no list column reads notes). */
export const LIST_CHANGING_EVENTS: readonly EventType[] = LEAD_CHANGING_EVENTS.filter((t) => t !== 'note.added');

/** Events that can move a KPI counter (note.added too: an activity with a note may also mark a lead serviced). */
export const KPI_EVENTS: readonly EventType[] = [
  'lead.updated', 'lead.allocated', 'state.changed', 'note.added', 'pipeline.run_completed',
];

/**
 * A lead.updated that only says new AI insights were stored (fields exactly ['insights'], written by the insights
 * batch). Insights don't bump companies.version and appear on no list, KPI or cached profile body (the profile reads
 * them per request), so caches have nothing to drop; the web refetches the open profile without a toast.
 */
export function isInsightsOnlyUpdate(event: { type: string; payload?: { fields?: unknown } | null }): boolean {
  const fields = event.payload?.fields;
  return event.type === 'lead.updated' && Array.isArray(fields) && fields.length === 1 && fields[0] === 'insights';
}
