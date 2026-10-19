import { eventCompanyIds, isInsightsOnlyUpdate, isUuid, type EventPayload, type LeadEvent } from '@leadmaker/shared';

// Redis Stream entry for one outbox_events row. Field names match @leadmaker/shared LeadEvent:
//   id          outbox_events.id (consumers dedupe on it; delivery is at-least-once)
//   type        event_type
//   company_id  outbox_events.company_id, or '' for multi-lead events (payload.company_ids)
//   payload     JSON: actor_type, actor_id, company_id(s), version, assigned_rep_id, previous_rep_id, ...
//   created_at  ISO timestamp of the outbox insert

export type OutboxRow = {
  id: string;
  event_type: string;
  company_id: string | null;
  payload: unknown;
  created_at: Date;
};

export function entryFields(r: OutboxRow): string[] {
  return [
    'id', r.id,
    'type', r.event_type,
    'company_id', r.company_id ?? '',
    'payload', JSON.stringify(r.payload ?? {}),
    'created_at', r.created_at.toISOString(),
  ];
}

/** A stream entry decoded for invalidation. */
export type StreamEvent = {
  streamId: string;
  outboxId: string;
  type: string;
  companyIds: string[];
  /** companyId -> version after the change, when the writer reported it. */
  versions: Map<string, number>;
  /** Users named by the payload: new and previous assignee, acting user. */
  users: string[];
  /** payload.assigned_rep_id / previous_rep_id: a user id, null (the pool), or undefined when absent. */
  assignedRepId: string | null | undefined;
  previousRepId: string | null | undefined;
  /** The event may touch leads it does not list (unreadable payload, truncated company_ids, or none at all). */
  incomplete: boolean;
  /** A batch-insights write (lead.updated with fields exactly ['insights']): no cache embeds insights. */
  insightsOnly: boolean;
};

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const USER_FIELDS = ['assigned_rep_id', 'previous_rep_id', 'previous_rep_ids', 'rep_id', 'actor_id'];

export function parseEntry(streamId: string, fields: string[]): StreamEvent | null {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  if (!f.type) return null;
  let payload = {} as EventPayload;
  let readable = false;
  try {
    const parsed = JSON.parse(f.payload ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) [payload, readable] = [parsed, true];
  } catch {
    // keep the event: its type alone still drives invalidation
  }
  const event = { company_id: f.company_id || null, payload } as Pick<LeadEvent, 'company_id' | 'payload'>;
  const companyIds = eventCompanyIds({ ...event, payload: { ...payload, company_ids: list(payload.company_ids) as string[] } })
    .filter(isUuid)
    .map((id) => id.toLowerCase());
  const versions = new Map<string, number>();
  if (payload.versions && typeof payload.versions === 'object') {
    for (const [id, v] of Object.entries(payload.versions as Record<string, unknown>)) {
      if (isUuid(id) && Number.isInteger(v)) versions.set(id.toLowerCase(), v as number);
    }
  }
  if (Number.isInteger(payload.version) && companyIds.length === 1) versions.set(companyIds[0], payload.version as number);
  const users = new Set<string>();
  for (const k of USER_FIELDS) for (const u of list(payload[k])) if (isUuid(u)) users.add(u.toLowerCase());
  const rep = (v: unknown) => (v === null ? null : isUuid(v) ? v.toLowerCase() : undefined);
  const listed = list(payload.company_ids).length;
  const truncated = payload.company_ids_truncated === true
    || (Number.isInteger(payload.changed_companies) && (payload.changed_companies as number) > listed);
  const ids = [...new Set(companyIds)];
  return {
    streamId, outboxId: f.id ?? '', type: f.type, companyIds: ids, versions, users: [...users],
    assignedRepId: rep(payload.assigned_rep_id),
    previousRepId: rep(payload.previous_rep_id),
    // a run that changed nothing lists no companies; any other event without one is not lead-scoped
    incomplete: !readable || truncated || (!ids.length && f.type !== 'pipeline.run_completed'),
    insightsOnly: readable && isInsightsOnlyUpdate({ type: f.type, payload: payload as { fields?: unknown } }),
  };
}
