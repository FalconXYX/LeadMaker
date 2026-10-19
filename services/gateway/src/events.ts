import {
  canView, eventCompanyIds, isEventType, isUuid, NOTIFICATION_CREATED, type EventPayload, type EventType, type LeadEvent,
} from '@leadmaker/shared';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Directory } from './directory.ts';
import type { Roles } from './roles.ts';
import type { AuthUser } from './types.ts';

/** A relayed event: a LeadEvent, or a notifier event shaped the same way. */
export type RelayedEvent = Omit<LeadEvent, 'type'> & { type: EventType | typeof NOTIFICATION_CREATED };

/** A stream entry (written by the relay with LeadEvent's field names) plus the companies it touches. */
export type StreamEvent = { streamId: string; event: RelayedEvent; companyIds: string[] };

/** One SSE message: `id:` is the stream id (EventSource resumes from it), data is the event. */
export type SseMessage = { id: string; event: string; data: RelayedEvent };

export function parseEntry(streamId: string, fields: string[]): StreamEvent | null {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  const notification = f.type === NOTIFICATION_CREATED;
  if (!isEventType(f.type) && !notification) return null;
  let payload: EventPayload;
  try {
    payload = JSON.parse(f.payload ?? '');
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.company_ids !== undefined && !Array.isArray(payload.company_ids)) return null;
  const event: RelayedEvent = { id: f.id ?? '', type: f.type as RelayedEvent['type'], company_id: f.company_id || null, payload, created_at: f.created_at ?? '' };
  if (notification) return { streamId, event, companyIds: [] };
  const ids = eventCompanyIds(event);
  // Anything that is not a uuid could name no company the viewer may see; such an event goes to managers only.
  const companyIds = ids.every(isUuid) ? [...new Set(ids.map((id) => id.toLowerCase()))] : null;
  return { streamId, event, companyIds: companyIds ?? ids };
}

/** Redis stream ids are "ms-seq"; numeric comparison, not string. */
export function compareIds(a: string, b: string): number {
  const [am, as = '0'] = a.split('-');
  const [bm, bs = '0'] = b.split('-');
  const d = BigInt(am) - BigInt(bm) || BigInt(as) - BigInt(bs);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

const STREAM_ID = /^\d{1,20}-\d{1,20}$/;
export const isStreamId = (v: unknown): v is string => typeof v === 'string' && STREAM_ID.test(v);

/** Current ownership of the companies in a batch of events. */
export type Visibility = { assigned: Map<string, string | null>; previous: Map<string, string> };

export async function resolveVisibility(events: StreamEvent[], dir: Directory): Promise<Visibility> {
  const ids = [...new Set(events.flatMap((e) => e.companyIds))];
  const allocated = [...new Set(events.filter((e) => e.event.type === 'lead.allocated').flatMap((e) => e.companyIds))];
  const [assigned, previous] = await Promise.all([dir.assignments(ids), dir.previousAssignees(allocated)]);
  return { assigned, previous };
}

/**
 * The shared visibility rule on the lead's current owner, plus one exception: a rep is told when a
 * lead is allocated away from them, so their UI can drop it. Unknown companies: managers only.
 */
export function canSee(user: AuthUser, companyId: string, e: StreamEvent, v: Visibility): boolean {
  if (user.role === 'manager') return true;
  if (!v.assigned.has(companyId)) return false;
  if (canView(user, v.assigned.get(companyId))) return true;
  if (e.event.type !== 'lead.allocated') return false;
  // The writer's previous_rep_id is the owner at event time (null: the lead came from the pool);
  // allocation history is only the fallback for events that do not carry it.
  if (e.companyIds.length === 1 && 'previous_rep_id' in e.event.payload) return e.event.payload.previous_rep_id === user.id;
  return v.previous.get(companyId) === user.id;
}

// A run completion reaches everyone: updated_in_last_poll moves for leads the run covered but did not list.
const BROADCAST = new Set<string>(['pipeline.run_completed']);

/**
 * A pool lead (previous_rep_id null) allocated to someone else: a rep who could see it in the pool must drop it,
 * but may not learn who got it.
 */
function leftPool(e: StreamEvent, user: AuthUser, v: Visibility): boolean {
  const { payload } = e.event;
  return user.role === 'rep' && e.event.type === 'lead.allocated' && e.companyIds.length === 1
    && v.assigned.has(e.companyIds[0]) && 'previous_rep_id' in payload && payload.previous_rep_id === null
    && isUuid(payload.assigned_rep_id) && payload.assigned_rep_id.toLowerCase() !== user.id;
}

/** The event as this user may see it: null when it touches none of their visible leads. */
export function project(e: StreamEvent, user: AuthUser, v: Visibility): SseMessage | null {
  const m = projectVisible(e, user, v);
  // Who asked for a job's run is the requester's (and managers') business, not every rep's.
  const requester = m?.data.payload.requested_by;
  if (!m || requester == null || user.role === 'manager' || String(requester).toLowerCase() === user.id) return m;
  const payload: EventPayload = { ...m.data.payload };
  delete payload.requested_by;
  return { ...m, data: { ...m.data, payload } };
}

function projectVisible(e: StreamEvent, user: AuthUser, v: Visibility): SseMessage | null {
  if (e.event.type === NOTIFICATION_CREATED) {
    const to = e.event.payload.user_id;
    return typeof to === 'string' && to.toLowerCase() === user.id ? { id: e.streamId, event: e.event.type, data: e.event } : null;
  }
  const visible = new Set(e.companyIds.filter((id) => canSee(user, id, e, v)));
  if (!visible.size && leftPool(e, user, v)) {
    const [company_id] = e.companyIds;
    const { actor_type, actor_id, actor_name } = e.event.payload;
    // An undefined actor_name (pipeline events) is left out of the JSON.
    const payload: EventPayload = { actor_type, actor_id: actor_id ?? null, actor_name, company_id, left_pool: true };
    return { id: e.streamId, event: e.event.type, data: { ...e.event, company_id, payload } };
  }
  if (e.companyIds.length && !visible.size && !BROADCAST.has(e.event.type)) return null;
  if (visible.size === e.companyIds.length) return { id: e.streamId, event: e.event.type, data: e.event };
  const { payload } = e.event;
  const keep = (id: unknown) => typeof id === 'string' && visible.has(id.toLowerCase());
  const filtered: EventPayload = { ...payload };
  if (payload.company_id !== undefined) {
    if (keep(payload.company_id)) filtered.company_id = payload.company_id;
    else delete filtered.company_id;
  }
  if (payload.company_ids) filtered.company_ids = payload.company_ids.filter(keep);
  if (payload.versions && typeof payload.versions === 'object') {
    filtered.versions = Object.fromEntries(Object.entries(payload.versions as object).filter(([id]) => keep(id)));
  }
  const company_id = keep(e.event.company_id) ? e.event.company_id : null;
  return { id: e.streamId, event: e.event.type, data: { ...e.event, company_id, payload: filtered } };
}

type Subscriber = { user: AuthUser; deliver(messages: SseMessage[]): void };

/**
 * One blocking XREAD loop per gateway process; each batch costs one ownership lookup, then is
 * filtered in memory for every connected user.
 */
export class EventHub {
  private subs = new Set<Subscriber>();
  private lastId = '0-0';
  private running = false;
  private loop?: Promise<void>;
  private blocking: Redis;
  private commands: Redis;
  private dir: Directory;
  private stream: string;
  private log: Logger;

  constructor(blocking: Redis, commands: Redis, dir: Directory, stream: string, log: Logger) {
    this.blocking = blocking;
    this.commands = commands;
    this.dir = dir;
    this.stream = stream;
    this.log = log;
  }

  async start(): Promise<void> {
    const last = (await this.commands.xrevrange(this.stream, '+', '-', 'COUNT', 1))[0];
    this.lastId = last?.[0] ?? '0-0';
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.blocking.disconnect();
    await this.loop;
  }

  get position(): string {
    return this.lastId;
  }

  connectionsFor(userId: string): number {
    let n = 0;
    for (const s of this.subs) if (s.user.id === userId) n++;
    return n;
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  /** Events after `afterId` that this user may see (EventSource reconnects with Last-Event-ID). */
  async replay(afterId: string, user: AuthUser, limit = 1000): Promise<SseMessage[]> {
    const entries = await this.commands.xrange(this.stream, `(${afterId}`, '+', 'COUNT', limit);
    const events = entries.map(([id, fields]) => parseEntry(id, fields)).filter((e) => e !== null);
    if (!events.length) return [];
    const v = await resolveVisibility(events, this.dir);
    return events.map((e) => project(e, user, v)).filter((m) => m !== null);
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.blocking.xread('COUNT', 500, 'BLOCK', 5000, 'STREAMS', this.stream, this.lastId);
        if (!res) continue;
        const entries = res[0][1];
        if (this.subs.size) {
          const events = entries.map(([id, fields]) => parseEntry(id, fields)).filter((e) => e !== null);
          const v = await resolveVisibility(events, this.dir);
          for (const sub of this.subs) {
            const messages = events.map((e) => project(e, sub.user, v)).filter((m) => m !== null);
            if (messages.length) sub.deliver(messages);
          }
        }
        this.lastId = entries[entries.length - 1][0];
      } catch (err) {
        if (!this.running) break;
        this.log.error({ err }, 'event stream read failed; retrying');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

const MAX_BUFFERED_BYTES = 1_048_576;

export function format(m: SseMessage): string {
  return `id: ${m.id}\nevent: ${m.event}\ndata: ${JSON.stringify(m.data)}\n\n`;
}

/**
 * GET /api/events: replay after Last-Event-ID, then live, with heartbeats; filtered by the user's current
 * role (re-read every roleCheckMs); ends when the JWT expires or the user is gone.
 */
export function sseHandler(
  hub: EventHub,
  opts: { maxPerUser: number; heartbeatMs: number; roles?: Roles; roleCheckMs?: number },
) {
  return async (req: Request, res: Response) => {
    // The hub filters with this object, so the role check below takes effect by updating it in place.
    const user: AuthUser = { ...req.user! };
    // A client that hung up while auth or the rate limiter was pending has already emitted 'close',
    // so a subscription made now would never be removed.
    if (res.destroyed) return;
    if (hub.connectionsFor(user.id) >= opts.maxPerUser) {
      res.status(429).set('Retry-After', '5').json({ error: 'too_many_streams' });
      return;
    }
    const resume = req.headers['last-event-id'] ?? req.query.lastEventId;
    let lastSent = isStreamId(resume) ? resume : '0-0';
    let replaying = true;
    let closed = false;
    const pending: SseMessage[] = [];
    const send = (m: SseMessage) => {
      if (closed || compareIds(m.id, lastSent) <= 0) return;
      lastSent = m.id;
      res.write(format(m));
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        req.log.warn({ userId: user.id }, 'SSE client too slow; closing');
        res.destroy();
      }
    };
    const unsubscribe = hub.subscribe({
      user,
      deliver: (messages) => (replaying ? pending.push(...messages) : messages.forEach(send)),
    });
    const timers: NodeJS.Timeout[] = [];
    res.on('close', () => {
      closed = true;
      unsubscribe();
      timers.forEach(clearTimeout);
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    try {
      if (isStreamId(resume)) for (const m of await hub.replay(resume, user)) send(m);
    } catch (err) {
      req.log.warn({ err }, 'SSE replay failed');
    }
    replaying = false;
    if (closed) return;
    pending.splice(0).forEach(send);
    res.write(`event: ready\ndata: ${JSON.stringify({ lastEventId: lastSent === '0-0' ? hub.position : lastSent })}\n\n`);

    timers.push(setInterval(() => res.write(': ping\n\n'), opts.heartbeatMs));
    const { roles } = opts;
    if (roles) {
      timers.push(setInterval(() => {
        roles.current(user.id).then((role) => {
          if (role) user.role = role;
          else res.end();
        }, (err: unknown) => req.log.warn({ err }, 'SSE role check failed; keeping the last role'));
      }, opts.roleCheckMs ?? 10_000));
    }
    const exp = res.locals.tokenExp as number | undefined;
    if (exp) {
      const ms = exp * 1000 - Date.now();
      timers.push(setTimeout(() => res.end(), Math.min(Math.max(ms, 0), 2 ** 31 - 1)));
    }
  };
}
