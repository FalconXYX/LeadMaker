import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Harness, url, type Fixture } from './harness.ts';

const h = new Harness();
const GHOST = '3d9f3c1a-0000-4000-8000-000000000000';
const byId = <T extends { companyId: string }>(xs: T[]) => [...xs].sort((a, b) => (a.companyId < b.companyId ? -1 : 1));

describe.skipIf(!url)('bulk unallocation and tag rename/delete', () => {
  let f: Fixture;

  beforeAll(() => h.start());
  afterAll(() => h.stop());
  beforeEach(async () => {
    f = await h.reset();
  });

  const owner = async (id: string) =>
    (await h.one<{ assigned_rep_id: string | null }>('SELECT assigned_rep_id FROM companies WHERE id = $1::uuid', id)).assigned_rep_id;
  const drift = () => h.all(`SELECT c.id FROM companies c
    LEFT JOIN lead_allocations la ON la.company_id = c.id AND la.ended_at IS NULL
    WHERE c.assigned_rep_id IS DISTINCT FROM la.rep_id`);

  describe('DELETE /api/allocations', () => {
    it('is manager-only and validates the batch, writing nothing', async () => {
      expect((await h.as(f.rep1).delete('/api/allocations', { companyIds: [f.leads.own] })).status).toBe(403);
      const mgr = h.as(f.manager);
      const missing = await mgr.delete('/api/allocations', { companyIds: [f.leads.own, GHOST] });
      expect([missing.status, missing.body]).toEqual([404, { error: 'not_found', details: { missing: [GHOST] } }]);
      expect((await mgr.delete('/api/allocations', { companyIds: [] })).status).toBe(400);
      expect((await mgr.delete('/api/allocations')).status).toBe(400);
      expect((await mgr.delete('/api/allocations', { companyIds: ['nope'] })).status).toBe(400);
      const many = Array.from({ length: 501 }, (_, i) => `2d9f3c1a-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const big = await mgr.delete('/api/allocations', { companyIds: many });
      expect([big.status, big.body]).toEqual([400, { error: 'too_many_leads', details: { matched: 501, max: 500 } }]);
      expect(await h.counts()).toEqual({ outbox: 0, activity: 0, audit: 0 });
      expect(await owner(f.leads.own)).toBe(f.rep1.id);
    });

    it('returns many leads to the pool in one transaction, exactly as the single release does', async () => {
      const mgr = h.as(f.manager);
      const res = await mgr.delete('/api/allocations', {
        companyIds: [f.leads.own, f.leads.pool, f.leads.other, f.leads.own.toUpperCase()],
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        unallocated: byId([
          { companyId: f.leads.own, previousRepId: f.rep1.id, version: 2 },
          { companyId: f.leads.other, previousRepId: f.rep2.id, version: 2 },
        ]),
        unchanged: [f.leads.pool],
      });
      expect([await owner(f.leads.own), await owner(f.leads.other)]).toEqual([null, null]);
      expect(await h.all('SELECT 1 FROM lead_allocations WHERE ended_at IS NULL')).toEqual([]);
      expect(await h.all<{ ended_by: string }>('SELECT ended_by FROM lead_allocations ORDER BY company_id'))
        .toEqual([{ ended_by: f.manager.id }, { ended_by: f.manager.id }]);
      expect(await drift()).toEqual([]);

      const events = (await h.outbox()).sort((a, b) => (a.company_id! < b.company_id! ? -1 : 1));
      expect(events.map((e) => [e.event_type, e.company_id, e.payload.previous_rep_id, e.payload.assigned_rep_id])).toEqual(
        byId([{ companyId: f.leads.own, prev: f.rep1.id }, { companyId: f.leads.other, prev: f.rep2.id }])
          .map((x) => ['lead.allocated', x.companyId, x.prev, null]));
      expect(events[0].payload).toMatchObject({ rep_id: null, actor_type: 'user', actor_id: f.manager.id, actor_name: 'Alex Manager', version: 2 });
      const diffs = await h.all<{ field_diff: unknown }>("SELECT field_diff FROM activity_logs WHERE action_type = 'allocation' ORDER BY company_id");
      expect(diffs.map((d) => d.field_diff)).toEqual(
        byId([{ companyId: f.leads.own, prev: f.rep1.id }, { companyId: f.leads.other, prev: f.rep2.id }])
          .map((x) => ({ assigned_rep_id: [x.prev, null] })));

      // The single release writes the same event and activity row.
      await mgr.post('/api/allocations', { companyIds: [f.leads.pool], repId: f.rep2.id });
      expect((await mgr.delete(`/api/allocations/${f.leads.pool}`)).body).toEqual({ companyId: f.leads.pool, previousRepId: f.rep2.id, version: 3 });
      const single = (await h.outbox()).at(-1)!;
      expect(Object.keys(single.payload).sort()).toEqual(Object.keys(events[0].payload).sort());
      expect((await mgr.delete('/api/allocations', { companyIds: [f.leads.pool] })).body).toEqual({ unallocated: [], unchanged: [f.leads.pool] });
      // The old reps lose write access; notes and history stay.
      expect((await h.as(f.rep1).post(`/api/leads/${f.leads.own}/notes`, { text: 'x' })).status).toBe(403);
    });

    it('runs alongside concurrent allocations over the same leads without deadlocks, ending consistent', async () => {
      const mgr = h.as(f.manager);
      await h.db.$executeRawUnsafe(`INSERT INTO companies (business_name, latitude, longitude, content_hash)
        SELECT 'Overlap ' || i, 40.7, -74.0, 'h' FROM generate_series(1, 30) i`);
      const ids = (await h.all<{ id: string }>('SELECT id FROM companies ORDER BY id')).map((r) => r.id);
      const results = await Promise.all([
        mgr.post('/api/allocations', { companyIds: ids.slice(0, 25), repId: f.rep1.id }),
        mgr.delete('/api/allocations', { companyIds: [...ids].reverse() }),
        mgr.post('/api/allocations/by-filter', { filter: { text: 'overlap' }, repId: f.rep2.id }),
        mgr.delete('/api/allocations', { companyIds: ids.slice(10) }),
        mgr.post('/api/allocations', { companyIds: [...ids].reverse().slice(0, 20), repId: f.rep2.id }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await drift()).toEqual([]);
      // Every lead's events chain: each one's previous owner is the owner the one before it left.
      const events = await h.all<{ company_id: string; prev: string | null; next: string | null }>(
        `SELECT company_id, payload->>'previous_rep_id' AS prev, payload->>'assigned_rep_id' AS next
         FROM outbox_events WHERE event_type = 'lead.allocated' ORDER BY id`);
      const last = new Map<string, string | null>();
      for (const e of events) {
        if (last.has(e.company_id)) expect(e.prev).toBe(last.get(e.company_id));
        last.set(e.company_id, e.next);
      }
      for (const [id, rep] of last) expect(await owner(id)).toBe(rep);
    });
  });

  describe('PATCH and DELETE /api/custom-tags/:id', () => {
    const tag = (name: string, by: string) =>
      h.one<{ id: string }>('INSERT INTO custom_tags (name, created_by) VALUES ($1, $2::uuid) RETURNING id', name, by);
    const link = (companyId: string, tagId: string) => h.db.$executeRawUnsafe(
      'INSERT INTO company_custom_tags (company_id, tag_id, added_by) VALUES ($1::uuid, $2::uuid, $3::uuid)', companyId, tagId, f.manager.id);
    const tagNames = async (companyId: string) => (await h.all<{ name: string }>(
      'SELECT t.name FROM company_custom_tags l JOIN custom_tags t ON t.id = l.tag_id WHERE l.company_id = $1::uuid ORDER BY t.name',
      companyId)).map((r) => r.name);

    it('lets only the creator or a manager rename or delete a tag', async () => {
      const { id } = await tag('Rep tag', f.rep1.id);
      expect((await h.as(f.rep2).patch(`/api/custom-tags/${id}`, { name: 'Mine now' })).status).toBe(403);
      expect((await h.as(f.rep2).delete(`/api/custom-tags/${id}`)).status).toBe(403);
      expect((await h.as(f.rep1).patch(`/api/custom-tags/${f.tag}`, { name: 'Not yours' })).status).toBe(403);
      expect((await h.as(f.rep1).patch(`/api/custom-tags/${GHOST}`, { name: 'x' })).body.error).toBe('tag_not_found');
      expect((await h.as(f.rep1).delete(`/api/custom-tags/${GHOST}`)).status).toBe(404);
      expect((await h.as(f.rep1).patch('/api/custom-tags/not-a-uuid', { name: 'x' })).status).toBe(400);
      expect((await h.as(f.rep1).patch(`/api/custom-tags/${id}`, { name: '  ' })).status).toBe(400);
      expect(await h.counts()).toEqual({ outbox: 0, activity: 0, audit: 0 });
      expect((await h.as(f.rep1).patch(`/api/custom-tags/${id}`, { name: 'Renamed by creator' })).status).toBe(200);
      expect((await h.as(f.manager).patch(`/api/custom-tags/${id}`, { name: 'Renamed by manager' })).status).toBe(200);
      expect((await h.as(f.manager).delete(`/api/custom-tags/${id}`)).status).toBe(200);
    });

    it('renames a tag keeping its links, bumping every tagged lead with an event, and answers 409 on a name clash', async () => {
      for (const lead of [f.leads.own, f.leads.pool, f.leads.other]) await link(lead, f.tag);
      const before = { own: await h.version(f.leads.own), other: await h.version(f.leads.other) };
      const res = await h.as(f.manager).patch(`/api/custom-tags/${f.tag}`, { name: ' Hail chaser ' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tag: { id: f.tag, name: 'Hail chaser', createdBy: f.manager.id }, previousName: 'Storm chaser' });
      expect(byId(res.body.leads)).toEqual(byId([
        { companyId: f.leads.own, version: before.own + 1 }, { companyId: f.leads.pool, version: 2 },
        { companyId: f.leads.other, version: before.other + 1 },
      ]));
      for (const lead of [f.leads.own, f.leads.pool, f.leads.other]) expect(await tagNames(lead)).toEqual(['Hail chaser']);
      const events = await h.outbox();
      expect(events).toHaveLength(4);
      expect(events.filter((e) => e.company_id === null)).toEqual([{
        event_type: 'tags.changed', company_id: null,
        payload: {
          tag_id: f.tag, tag_name: 'Hail chaser', previous_name: 'Storm chaser', renamed: true,
          actor_type: 'user', actor_id: f.manager.id, actor_name: 'Alex Manager',
        },
      }]);
      expect(events.find((e) => e.company_id === f.leads.other)?.payload).toEqual({
        company_id: f.leads.other, tag_id: f.tag, tag_name: 'Hail chaser', previous_name: 'Storm chaser', renamed: true,
        assigned_rep_id: f.rep2.id, version: before.other + 1, actor_type: 'user', actor_id: f.manager.id, actor_name: 'Alex Manager',
      });
      expect(await h.one('SELECT action, changes FROM audit_events')).toEqual({ action: 'renamed', changes: { name: ['Storm chaser', 'Hail chaser'] } });

      // A case-only rename is a rename; the same name is a no-op; another tag's name (any case) is 409.
      expect((await h.as(f.manager).patch(`/api/custom-tags/${f.tag}`, { name: 'HAIL chaser' })).body.tag.name).toBe('HAIL chaser');
      const n = (await h.counts()).outbox;
      expect((await h.as(f.manager).patch(`/api/custom-tags/${f.tag}`, { name: 'HAIL chaser' })).body).toMatchObject({ leads: [] });
      expect((await h.counts()).outbox).toBe(n);
      await tag('Insurance job', f.rep1.id);
      const clash = await h.as(f.manager).patch(`/api/custom-tags/${f.tag}`, { name: 'insurance JOB' });
      expect([clash.status, clash.body]).toEqual([409, { error: 'name_taken', details: { name: 'insurance JOB' } }]);
      expect((await h.counts()).outbox).toBe(n);
    });

    it('shows a creator rep only the leads they may see', async () => {
      const { id } = await tag('Rep tag', f.rep1.id);
      for (const lead of [f.leads.own, f.leads.pool, f.leads.other]) await link(lead, id);
      const renamed = await h.as(f.rep1).patch(`/api/custom-tags/${id}`, { name: 'Rep tag 2' });
      expect(renamed.body.leads.map((l: { companyId: string }) => l.companyId).sort()).toEqual([f.leads.own, f.leads.pool].sort());
      expect(await h.version(f.leads.other)).toBe(2);
      const deleted = await h.as(f.rep1).delete(`/api/custom-tags/${id}`);
      expect(deleted.body.leads.map((l: { companyId: string }) => l.companyId).sort()).toEqual([f.leads.own, f.leads.pool].sort());
      expect(await h.version(f.leads.other)).toBe(3);
    });

    it('deletes a tag by unlinking it from every lead as the single unlink does, in one transaction', async () => {
      const other = await tag('Keep me', f.manager.id);
      for (const lead of [f.leads.own, f.leads.other]) await link(lead, f.tag);
      await link(f.leads.own, other.id);
      const res = await h.as(f.manager).delete(`/api/custom-tags/${f.tag}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ deleted: true, tagId: f.tag, name: 'Storm chaser' });
      expect(byId(res.body.leads)).toEqual(byId([{ companyId: f.leads.own, version: 2 }, { companyId: f.leads.other, version: 2 }]));
      expect(await h.all('SELECT 1 FROM custom_tags WHERE id = $1::uuid', f.tag)).toEqual([]);
      expect([await tagNames(f.leads.own), await tagNames(f.leads.other)]).toEqual([['Keep me'], []]);
      const diffs = await h.all<{ field_diff: unknown }>("SELECT field_diff FROM activity_logs WHERE action_type = 'custom_tag'");
      expect(diffs.map((d) => d.field_diff)).toEqual([0, 1].map(() => ({ custom_tag: [{ id: f.tag, name: 'Storm chaser' }, null] })));
      const events = await h.outbox();
      expect(events.map((e) => [e.company_id, e.payload.deleted, e.payload.added]).sort()).toEqual(
        [[f.leads.own, true, false], [f.leads.other, true, false], [null, true, undefined]].sort());
      expect(await h.one('SELECT action, changes FROM audit_events')).toEqual({ action: 'deleted', changes: { name: ['Storm chaser', null], leads: 2 } });

      // The single unlink writes the same activity row and the same event fields (plus deleted).
      await h.as(f.manager).delete(`/api/leads/${f.leads.own}/custom-tags/${other.id}`);
      const single = (await h.outbox()).at(-1)!;
      const bulk = events.find((e) => e.company_id === f.leads.own)!;
      expect(Object.keys(bulk.payload).filter((k) => k !== 'deleted').sort()).toEqual(Object.keys(single.payload).sort());
      expect((await h.as(f.manager).delete(`/api/custom-tags/${f.tag}`)).status).toBe(404);
    });

    it('never loses a link to a concurrent delete: every lead tagged before it commits is untagged with an event', async () => {
      await h.db.$executeRawUnsafe(`INSERT INTO companies (business_name, latitude, longitude, content_hash)
        SELECT 'Tagged ' || i, 40.7, -74.0, 'h' FROM generate_series(1, 20) i`);
      const ids = (await h.all<{ id: string }>("SELECT id FROM companies WHERE business_name LIKE 'Tagged %' ORDER BY id")).map((r) => r.id);
      for (const id of ids.slice(0, 5)) await link(id, f.tag);
      const mgr = h.as(f.manager);
      const results = await Promise.all([
        mgr.post(`/api/custom-tags/${f.tag}/leads`, { companyIds: [...ids].reverse() }),
        mgr.post(`/api/leads/${ids[7]}/custom-tags`, { tagId: f.tag }),
        mgr.patch(`/api/custom-tags/${f.tag}`, { name: 'Renamed mid-flight' }),
        mgr.delete(`/api/custom-tags/${f.tag}`),
        mgr.post(`/api/custom-tags/${f.tag}/leads`, { companyIds: ids.slice(3, 15) }),
        mgr.post(`/api/leads/${ids[18]}/custom-tags`, { tagId: f.tag }),
      ]);
      for (const r of results) expect([200, 201, 404]).toContain(r.status);
      expect(results[3].status).toBe(200);
      expect(await h.all('SELECT 1 FROM company_custom_tags')).toEqual([]);
      // Per lead, links and unlinks alternate: the delete untagged every lead the tag was on when it committed.
      const events = await h.all<{ company_id: string; added: boolean | null; deleted: boolean | null }>(
        `SELECT company_id, (payload->>'added')::boolean AS added, (payload->>'deleted')::boolean AS deleted
         FROM outbox_events WHERE company_id IS NOT NULL AND payload->>'renamed' IS NULL ORDER BY id`);
      const tagged = new Map<string, boolean>(ids.slice(0, 5).map((id) => [id, true]));
      for (const e of events) {
        expect(e.added ? !tagged.get(e.company_id) : tagged.get(e.company_id)).toBe(true);
        tagged.set(e.company_id, !!e.added);
      }
      expect([...tagged.values()].some(Boolean)).toBe(false);
    });
  });
});
