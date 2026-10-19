import { Prisma } from '@leadmaker/db';
import { canView, type NotificationCreatedPayload, type NotificationType, type Role } from '@leadmaker/shared';

export type Tx = Prisma.TransactionClient;
export type Data = Record<string, unknown>;

/** A notification a rule wants to send; drafts with the same user and dedupe key merge. */
export type Draft = {
  userId: string;
  type: NotificationType;
  dedupeKey: string;
  companyId?: string | null;
  /** The lead link is only a convenience: dropped, not the whole notification, when the user cannot open the lead. */
  optionalLink?: boolean;
  countyFips?: string | null;
  /** Added to count on a merge (leads allocated, new pool leads); default 1. */
  increment?: number;
  data: Data;
  /** At most one row per user and key, read or not (storm alerts, finished jobs). */
  once?: boolean;
  /** The event's acting user, who is never notified about their own action. */
  actorId?: string | null;
  render: (count: number, data: Data) => { title: string; body: string };
};

export type Written = { id: string; userId: string; type: NotificationType; count: number; title: string; body: string };

const MAX_LIST = 50;

/** Shallow merge; arrays (company_ids, fields, ...) are unioned, newest last, capped at MAX_LIST. */
export function mergeData(a: Data, b: Data): Data {
  const out: Data = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (Array.isArray(prev) && Array.isArray(v)) {
      const seen = new Map<string, unknown>();
      for (const x of [...prev, ...v]) {
        const key = JSON.stringify(x);
        seen.delete(key);
        seen.set(key, x);
      }
      out[k] = [...seen.values()].slice(-MAX_LIST);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Group = Omit<Draft, 'increment'> & { increment: number };

/** Drops what may not be sent, then merges drafts that share a user and dedupe key, in order. */
async function prepare(tx: Tx, drafts: Draft[]): Promise<Group[]> {
  const candidates = drafts.filter((d) => d.userId !== d.actorId);
  if (!candidates.length) return [];
  const userIds = [...new Set(candidates.map((d) => d.userId))];
  const companyIds = [...new Set(candidates.flatMap((d) => (d.companyId ? [d.companyId] : [])))];
  const [users, muted, companies] = await Promise.all([
    tx.$queryRaw<{ id: string; role: string }[]>`SELECT id::text, role FROM users WHERE id = ANY(${userIds}::uuid[])`,
    tx.$queryRaw<{ user_id: string; type: string }[]>`
      SELECT user_id::text, type FROM notification_preferences WHERE NOT enabled AND user_id = ANY(${userIds}::uuid[])`,
    companyIds.length
      ? tx.$queryRaw<{ id: string; assigned_rep_id: string | null }[]>`
          SELECT id::text, assigned_rep_id::text FROM companies WHERE id = ANY(${companyIds}::uuid[])`
      : [],
  ]);
  const roles = new Map(users.map((u) => [u.id, (u.role === 'manager' ? 'manager' : 'rep') as Role]));
  const off = new Set(muted.map((m) => `${m.user_id}:${m.type}`));
  const owner = new Map(companies.map((c) => [c.id, c.assigned_rep_id]));
  const groups = new Map<string, Group>();
  for (let d of candidates) {
    const role = roles.get(d.userId);
    if (!role || off.has(`${d.userId}:${d.type}`)) continue;
    // Never point anyone at a lead they cannot open (it may have moved since the event).
    if (d.companyId && (!owner.has(d.companyId) || !canView({ id: d.userId, role }, owner.get(d.companyId)))) {
      if (!d.optionalLink) continue;
      d = { ...d, companyId: null };
    }
    const key = `${d.userId}\n${d.dedupeKey}`;
    const prev = groups.get(key);
    const increment = d.increment ?? 1;
    if (!prev) {
      groups.set(key, { ...d, increment });
      continue;
    }
    groups.set(key, {
      ...d,
      companyId: d.companyId ?? prev.companyId,
      countyFips: d.countyFips ?? prev.countyFips,
      increment: prev.increment + increment,
      data: mergeData(prev.data, d.data),
    });
  }
  return [...groups.values()];
}

type Upserted = { id: string; count: number; title: string; body: string };

async function upsert(tx: Tx, g: Group): Promise<Upserted | null> {
  const dedupeKey = clip(g.dedupeKey, 255);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (g.once) {
      const seen = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM notifications WHERE user_id = ${g.userId}::uuid AND dedupe_key = ${dedupeKey} LIMIT 1`;
      if (seen.length) return null;
    } else {
      const [cur] = await tx.$queryRaw<{ id: string; count: number; data: Data }[]>`
        SELECT id::text, count, data FROM notifications
        WHERE user_id = ${g.userId}::uuid AND dedupe_key = ${dedupeKey} AND read_at IS NULL
        FOR UPDATE`;
      if (cur) {
        const count = cur.count + g.increment;
        const data = mergeData(cur.data, g.data);
        const { title, body } = g.render(count, data);
        await tx.$executeRaw`
          UPDATE notifications
          SET count = ${count}, data = ${JSON.stringify(data)}::jsonb, title = ${clip(title, 255)}, body = ${body},
              company_id = COALESCE(${g.companyId ?? null}::uuid, company_id),
              county_fips = COALESCE(${g.countyFips ?? null}, county_fips), updated_at = clock_timestamp()
          WHERE id = ${cur.id}::uuid`;
        return { id: cur.id, count, title: clip(title, 255), body };
      }
    }
    const { title, body } = g.render(g.increment, g.data);
    // A concurrent insert of the same unread key wins; the next pass merges into (or skips) its row.
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title, body, company_id, county_fips, data, dedupe_key, count, created_at, updated_at)
      VALUES (${g.userId}::uuid, ${g.type}, ${clip(title, 255)}, ${body}, ${g.companyId ?? null}::uuid, ${g.countyFips ?? null},
              ${JSON.stringify(g.data)}::jsonb, ${dedupeKey}, ${g.increment}, clock_timestamp(), clock_timestamp())
      ON CONFLICT (user_id, dedupe_key) WHERE read_at IS NULL DO NOTHING
      RETURNING id::text`;
    if (row) return { id: row.id, count: g.increment, title: clip(title, 255), body };
  }
  throw new Error(`notification upsert for ${g.dedupeKey} kept conflicting`);
}

/**
 * Writes the drafts (merging into unread rows, honouring opt-outs, never notifying the actor) and, in the
 * same transaction, one outbox 'notification.created' per notification written, for the gateway's SSE.
 */
export async function writeDrafts(tx: Tx, drafts: Draft[]): Promise<Written[]> {
  const written: Written[] = [];
  for (const g of await prepare(tx, drafts)) {
    const row = await upsert(tx, g);
    if (row) written.push({ ...row, userId: g.userId, type: g.type });
  }
  if (written.length) {
    // No company_id on these rows or payloads: they change no lead, so no lead cache or lead stream filter applies.
    // Title and body ride along, so the client can show the notification without fetching it.
    const payloads = written.map((w): NotificationCreatedPayload => ({
      user_id: w.userId, notification_id: w.id, type: w.type, count: w.count, title: w.title, body: w.body,
      actor_type: 'system', actor_id: null, actor_name: 'system',
    }));
    await tx.$executeRaw`
      INSERT INTO outbox_events (event_type, payload)
      SELECT 'notification.created', e FROM jsonb_array_elements(${JSON.stringify(payloads)}::jsonb) AS e`;
  }
  return written;
}
