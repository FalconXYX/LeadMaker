import { afterEach, describe, expect, it, vi } from 'vitest';
import { qk } from '@/api/queries';
import { EventStreamConnection } from '@/live/connection';
import { RESYNC_KEYS, actorNameOf, invalidationsFor, isInsightsOnly, isOwnEvent, parseLiveEvent, type LiveEvent } from '@/live/eventMap';

const LEAD = 'c0ffee00-0000-4000-8000-000000000001';

describe('invalidationsFor', () => {
  it.each(['lead.updated', 'lead.allocated', 'note.added', 'state.changed', 'override.set', 'tags.changed'] as const)(
    '%s invalidates that lead, every list and the KPIs',
    (type) => {
      const keys = invalidationsFor({ type, companyIds: [LEAD] });
      expect(keys).toContainEqual(qk.leads.detail(LEAD));
      expect(keys).toContainEqual(qk.leads.activityAll(LEAD));
      expect(keys).toContainEqual(qk.leads.lists);
      expect(keys).toContainEqual(qk.kpis);
      expect(keys).not.toContainEqual(qk.notifications.all);
    },
  );

  it('lead.allocated also refreshes suggestions and users; tags.changed the tag catalog', () => {
    expect(invalidationsFor({ type: 'lead.allocated', companyIds: [LEAD] })).toEqual(
      expect.arrayContaining([qk.allocationsAll, qk.usersAll]),
    );
    expect(invalidationsFor({ type: 'tags.changed', companyIds: [LEAD] })).toContainEqual(qk.customTags);
  });

  it('task writes (lead.updated with fields tasks) and allocations refresh the task lists', () => {
    expect(invalidationsFor({ type: 'lead.updated', companyIds: [LEAD], payload: { fields: ['tasks'] } })).toContainEqual(qk.tasks);
    expect(invalidationsFor({ type: 'lead.updated', companyIds: [LEAD], payload: { fields: ['sales_stage'] } })).not.toContainEqual(qk.tasks);
    expect(invalidationsFor({ type: 'lead.allocated', companyIds: [LEAD] })).toContainEqual(qk.tasks);
    expect(RESYNC_KEYS).toContainEqual(qk.tasks);
  });

  it('pipeline.run_completed refreshes lists, KPIs and the territory brief but no single lead', () => {
    const keys = invalidationsFor({ type: 'pipeline.run_completed', companyIds: [] });
    expect(keys).toEqual(expect.arrayContaining([qk.leads.lists, qk.kpis, qk.territoryBriefAll]));
    expect(keys.some((k) => k[1] === 'detail')).toBe(false);
  });

  it('a new AI insight (lead.updated with fields exactly [insights]) refreshes only that profile', () => {
    const other = 'c0ffee00-0000-4000-8000-000000000002';
    expect(invalidationsFor({ type: 'lead.updated', companyIds: [LEAD, other], payload: { fields: ['insights'], material: false } }))
      .toEqual([qk.leads.detail(LEAD), qk.leads.detail(other)]);
    // Anything else alongside it is a normal update.
    const mixed = invalidationsFor({ type: 'lead.updated', companyIds: [LEAD], payload: { fields: ['insights', 'tier'] } });
    expect(mixed).toEqual(expect.arrayContaining([qk.leads.lists, qk.kpis]));
    expect(isInsightsOnly({ fields: ['insights'] })).toBe(true);
    expect(isInsightsOnly({ fields: [] })).toBe(false);
    expect(isInsightsOnly(undefined)).toBe(false);
  });

  it('notification.created refreshes notifications only', () => {
    expect(invalidationsFor({ type: 'notification.created', companyIds: [] })).toEqual([qk.notifications.all]);
  });

  it('covers every company an event touches', () => {
    const other = 'c0ffee00-0000-4000-8000-000000000002';
    const keys = invalidationsFor({ type: 'lead.allocated', companyIds: [LEAD, other] });
    expect(keys).toContainEqual(qk.leads.detail(other));
  });
});

describe('parseLiveEvent', () => {
  it('reads company ids from company_id and payload.company_ids, de-duplicated', () => {
    const e = parseLiveEvent('lead.allocated', '1-0', JSON.stringify({
      id: '1-0', type: 'lead.allocated', company_id: LEAD,
      payload: { actor_type: 'user', actor_id: 'm1', company_ids: [LEAD, 'b'] }, created_at: '',
    }))!;
    expect(e.companyIds).toEqual([LEAD, 'b']);
    expect(isOwnEvent(e, 'm1')).toBe(true);
    expect(isOwnEvent(e, 'r1')).toBe(false);
  });

  it('exposes payload.actor_name as actorName (null when absent or blank)', () => {
    const e = parseLiveEvent('override.set', '1-1', JSON.stringify({
      id: '1-1', type: 'override.set', company_id: LEAD,
      payload: { actor_type: 'user', actor_id: 'm1', actor_name: 'Alex Morgan', field: 'phone' }, created_at: '',
    }))!;
    expect(e.actorName).toBe('Alex Morgan');
    const pipeline = parseLiveEvent('lead.updated', '1-2', JSON.stringify({
      id: '1-2', type: 'lead.updated', company_id: LEAD, payload: { actor_type: 'pipeline', actor_id: null }, created_at: '',
    }))!;
    expect(pipeline.actorName).toBeNull();
    expect(actorNameOf({ payload: { actor_name: '  ' } })).toBeNull();
    // Hand-built events without actorName still resolve from the payload.
    expect(actorNameOf({ payload: { actor_name: 'Sam Rivera' } })).toBe('Sam Rivera');
  });

  it('accepts a flat notification payload and rejects unknown types or bad JSON', () => {
    const n = parseLiveEvent('notification.created', '2-0', JSON.stringify({ user_id: 'u', notification_id: 'n', type: 'lead_assigned' }))!;
    expect(n.payload.notification_id).toBe('n');
    const titled = parseLiveEvent('notification.created', '2-1', JSON.stringify({
      user_id: 'u', notification_id: 'n2', type: 'allocated', count: 1, title: 'New lead', body: 'Acme', actor_type: 'system', actor_id: null, actor_name: 'system',
    }))!;
    expect(titled.actorName).toBe('system');
    expect(titled.payload.title).toBe('New lead');
    expect(parseLiveEvent('something.else', '3-0', '{}')).toBeNull();
    expect(parseLiveEvent('lead.updated', '3-0', 'not json')).toBeNull();
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onerror: ((ev: Event) => unknown) | null = null;
  onopen: ((ev: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, ((ev: Event) => void)[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown, lastEventId = '') {
    const ev = new MessageEvent(type, { data: JSON.stringify(data), lastEventId });
    this.listeners.get(type)?.forEach((fn) => fn(ev));
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
}

describe('EventStreamConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeEventSource.instances = [];
  });

  it('dispatches events, reconnects with backoff, resumes from the last id and resyncs', () => {
    vi.useFakeTimers();
    const events: LiveEvent[] = [];
    const statuses: string[] = [];
    const onResync = vi.fn();
    const conn = new EventStreamConnection({
      url: (last) => `/api/events?access_token=t${last ? `&lastEventId=${last}` : ''}`,
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      onResync,
      createEventSource: (u) => new FakeEventSource(u),
      baseDelayMs: 1000,
      random: () => 1,
    });
    conn.start();
    const first = FakeEventSource.instances[0]!;
    first.emit('ready', { lastEventId: '5-0' });
    first.emit('state.changed', { type: 'state.changed', company_id: LEAD, payload: { actor_type: 'user', actor_id: 'x' } }, '6-0');
    expect(events).toHaveLength(1);
    expect(events[0]!.companyIds).toEqual([LEAD]);
    expect(onResync).not.toHaveBeenCalled();

    first.fail();
    expect(first.closed).toBe(true);
    expect(conn.status).toBe('reconnecting');
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toContain('lastEventId=6-0');

    second.fail();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    const third = FakeEventSource.instances[2]!;
    third.emit('ready', { lastEventId: '6-0' });
    expect(conn.status).toBe('open');
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);

    conn.stop();
    expect(third.closed).toBe(true);
  });

  it('stops and reports auth loss when there is no valid token', () => {
    const onAuthLost = vi.fn();
    const conn = new EventStreamConnection({
      url: () => null, onEvent: () => {}, onAuthLost, createEventSource: (u) => new FakeEventSource(u),
    });
    conn.start();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(conn.status).toBe('closed');
  });

  it('exposes resync keys covering lists, KPIs and notifications', () => {
    expect(RESYNC_KEYS).toEqual(expect.arrayContaining([qk.leads.all, qk.kpis, qk.notifications.all]));
  });
});
