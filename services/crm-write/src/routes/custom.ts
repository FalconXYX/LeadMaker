import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import {
  canView, canWrite, isManager, type BulkTagAttachResult, type CustomFieldSet, type CustomTagCreated,
  type CustomTagDeleted, type CustomTagRecord, type CustomTagUpdated, type LeadTagAdded, type LeadTagRemoved,
  type TagLeadVersion,
} from '@leadmaker/shared';
import { actorOf, type Actor } from '../auth.ts';
import { badRequest, forbidden, HttpError, notFound, parse, pgCode, uuid } from '../http.ts';
import { bumpCompany, conflict, emit, lockLead, logActivity, type Json, type Tx } from '../tx.ts';
import type { Deps } from '../app.ts';

const MAX_CUSTOM_FIELDS = 100;
const tagName = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}]+$/u, 'must not contain control characters');
const tagBody = z.object({ name: tagName });
const linkBody = z.object({ tagId: uuid });
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lowercase letters, digits and _; starts with a letter');
const fieldBody = z.object({
  value: z.union([z.string().trim().max(1000), z.number().finite(), z.boolean(), z.null()]),
  version: z.int().positive(),
});

type Tag = { id: string; name: string; created_by: string; created_at: Date };
const tagOut = (t: Tag): CustomTagRecord => ({ id: t.id, name: t.name, createdBy: t.created_by, createdAt: t.created_at.toISOString() });

type TaggedLead = { id: string; assigned_rep_id: string | null };
type BumpedLead = TagLeadVersion & { assignedRepId: string | null };

const nameTaken = (name: string) => new HttpError(409, { error: 'name_taken', details: { name } });

/**
 * Locks a tag for a rename or delete (its creator or a manager) together with every lead carrying it, whose
 * versions move with it. The tag first, in a mode that serialises renames and deletes but lets links proceed;
 * then the tagged leads in id order, as every multi-lead writer locks; then the tag for update, which holds off
 * new links until commit; then any lead linked in between.
 */
async function lockTag(tx: Tx, actor: Actor, id: string): Promise<{ tag: Tag; leads: TaggedLead[] }> {
  const [tag] = await tx.$queryRaw<Tag[]>(Prisma.sql`
    SELECT id, name, created_by, created_at FROM custom_tags WHERE id = ${id}::uuid FOR NO KEY UPDATE`);
  if (!tag) throw notFound('tag_not_found');
  if (tag.created_by !== actor.id && !isManager(actor)) throw forbidden('only the tag\'s creator or a manager may change it');
  const tagged = (except: string[]) => tx.$queryRaw<TaggedLead[]>(Prisma.sql`
    SELECT c.id, c.assigned_rep_id FROM companies c
    WHERE c.id IN (SELECT company_id FROM company_custom_tags WHERE tag_id = ${id}::uuid) AND c.id <> ALL(${except}::uuid[])
    ORDER BY c.id FOR NO KEY UPDATE OF c`);
  const leads = await tagged([]);
  await tx.$executeRaw(Prisma.sql`SELECT 1 FROM custom_tags WHERE id = ${id}::uuid FOR UPDATE`);
  leads.push(...await tagged(leads.map((l) => l.id)));
  return { tag, leads };
}

/** A tag about to be linked, held (after the lead locks, as lockTag orders them) so a concurrent delete waits. */
async function shareTag(tx: Tx, id: string): Promise<Tag> {
  const [tag] = await tx.$queryRaw<Tag[]>(Prisma.sql`
    SELECT id, name, created_by, created_at FROM custom_tags WHERE id = ${id}::uuid FOR KEY SHARE`);
  if (!tag) throw notFound('tag_not_found');
  return tag;
}

async function auditTag(tx: Tx, actor: Actor, tagId: string, action: string, changes: Record<string, Json>): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO audit_events (entity_type, entity_id, action, changes, actor_type, actor_id)
    VALUES ('custom_tag', ${tagId}, ${action}, ${JSON.stringify(changes)}::jsonb, 'user', ${actor.id}::uuid)`);
}

/** The bumped leads the actor may see, for the response (a creator rep's tag may be on other reps' leads). */
const visibleLeads = (actor: Actor, leads: BumpedLead[]): TagLeadVersion[] =>
  leads.filter((l) => canView(actor, l.assignedRepId)).map(({ companyId, version }) => ({ companyId, version }));

export function customRoutes({ write, config }: Deps): Router {
  const r = Router();
  const bulkLinkBody = z.object({ companyIds: z.array(uuid).min(1).max(config.maxBulkTag) });

  // Tag names are unique ignoring case; creating an existing name returns that tag (200, created: false).
  r.post('/custom-tags', async (req, res) => {
    const actor = actorOf(res);
    const { name } = parse(tagBody, req.body);
    const out = await write(actor, async (tx) => {
      const find = () => tx.$queryRaw<Tag[]>(Prisma.sql`
        SELECT id, name, created_by, created_at FROM custom_tags WHERE lower(name) = lower(${name})`);
      const [existing] = await find();
      if (existing) return { tag: existing, created: false };
      const [tag] = await tx.$queryRaw<Tag[]>(Prisma.sql`
        INSERT INTO custom_tags (name, created_by) VALUES (${name}, ${actor.id}::uuid)
        ON CONFLICT DO NOTHING RETURNING id, name, created_by, created_at`);
      if (!tag) return { tag: (await find())[0], created: false };
      await auditTag(tx, actor, tag.id, 'created', { name: [null, name] });
      await emit(tx, actor, 'tags.changed', null, { tag_id: tag.id, tag_name: tag.name, created: true });
      return { tag, created: true };
    });
    res.status(out.created ? 201 : 200).json({ tag: tagOut(out.tag), created: out.created } satisfies CustomTagCreated);
  });

  // Tags are a set, so linking needs no version check; it still bumps the lead version (profiles show tags).
  r.post('/leads/:id/custom-tags', async (req, res) => {
    const actor = actorOf(res);
    const { tagId } = parse(linkBody, req.body);
    const out = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'update');
      const tag = await shareTag(tx, tagId);
      const linked = await tx.$queryRaw<unknown[]>(Prisma.sql`
        INSERT INTO company_custom_tags (company_id, tag_id, added_by)
        VALUES (${lead.id}::uuid, ${tag.id}::uuid, ${actor.id}::uuid)
        ON CONFLICT DO NOTHING RETURNING tag_id`);
      if (linked.length === 0) return { tag, added: false, version: lead.version };
      const { version } = await bumpCompany(tx, lead.id);
      await logActivity(tx, actor, lead.id, 'custom_tag', { fieldDiff: { custom_tag: [null, { id: tag.id, name: tag.name }] } });
      await emit(tx, actor, 'tags.changed', lead.id, {
        tag_id: tag.id, tag_name: tag.name, added: true, assigned_rep_id: lead.assigned_rep_id, version,
      });
      return { tag, added: true, version };
    });
    res.status(out.added ? 201 : 200).json({ tag: tagOut(out.tag), added: out.added, version: out.version } satisfies LeadTagAdded);
  });

  // The single link above for many leads in one transaction: the ones the actor may write are tagged (version
  // bump, activity row, tags.changed event each); read-only and invisible ones are skipped and reported.
  r.post('/custom-tags/:id/leads', async (req, res) => {
    const actor = actorOf(res);
    const tagId = parse(uuid, req.params.id);
    const ids = [...new Set(parse(bulkLinkBody, req.body).companyIds)];
    const out = await write(actor, async (tx) => {
      // Locked in id order, as every multi-lead writer does.
      const rows = await tx.$queryRaw<{ id: string; assigned_rep_id: string | null }[]>(Prisma.sql`
        SELECT id, assigned_rep_id FROM companies WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`);
      const tag = await shareTag(tx, tagId);
      const owner = new Map(rows.map((row) => [row.id, row.assigned_rep_id]));
      const visible = ids.filter((id) => owner.has(id) && canView(actor, owner.get(id)));
      const writable = visible.filter((id) => canWrite(actor, owner.get(id)));
      const custom = JSON.stringify({ id: tag.id, name: tag.name });
      const attached = await tx.$queryRaw<{ companyId: string; version: number }[]>(Prisma.sql`
        WITH linked AS (
          INSERT INTO company_custom_tags (company_id, tag_id, added_by)
          SELECT w.id, ${tag.id}::uuid, ${actor.id}::uuid FROM unnest(${writable}::uuid[]) AS w(id)
          ON CONFLICT DO NOTHING RETURNING company_id
        ), upd AS (
          UPDATE companies c SET version = c.version + 1 FROM linked WHERE c.id = linked.company_id
          RETURNING c.id, c.version, c.assigned_rep_id
        ), act AS (
          INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at)
          SELECT id, 'user', ${actor.id}::uuid, 'custom_tag',
                 jsonb_build_object('custom_tag', jsonb_build_array(NULL, ${custom}::jsonb)), clock_timestamp()
          FROM upd
        ), evt AS (
          INSERT INTO outbox_events (event_type, company_id, payload)
          SELECT 'tags.changed', id, jsonb_build_object(
            'company_id', id, 'tag_id', ${tag.id}::uuid, 'tag_name', ${tag.name}::text, 'added', true,
            'assigned_rep_id', assigned_rep_id, 'version', version, 'actor_type', 'user', 'actor_id', ${actor.id}::uuid,
            'actor_name', ${actor.name}::text)
          FROM upd
        )
        SELECT id AS "companyId", version FROM upd ORDER BY id`);
      const done = new Set(attached.map((a) => a.companyId));
      return {
        tag: tagOut(tag),
        attached,
        alreadyTagged: writable.filter((id) => !done.has(id)),
        skippedReadOnly: visible.filter((id) => !canWrite(actor, owner.get(id))),
        skippedInvisible: ids.filter((id) => !owner.has(id) || !canView(actor, owner.get(id))),
      } satisfies BulkTagAttachResult;
    });
    res.json(out);
  });

  // Renames a tag everywhere: links stay, and every tagged lead's version moves (profiles cache tag names per version)
  // with a tags.changed event each; plus one tag-level event for tag lists.
  r.patch('/custom-tags/:id', async (req, res) => {
    const actor = actorOf(res);
    const id = parse(uuid, req.params.id);
    const { name } = parse(tagBody, req.body);
    const out = await write(actor, async (tx) => {
      const { tag, leads } = await lockTag(tx, actor, id);
      if (name === tag.name) return { tag: tagOut(tag), previousName: tag.name, leads: [] };
      const [clash] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM custom_tags WHERE lower(name) = lower(${name}) AND id <> ${tag.id}::uuid`);
      if (clash) throw nameTaken(name);
      let renamed: Tag;
      try {
        [renamed] = await tx.$queryRaw<Tag[]>(Prisma.sql`
          UPDATE custom_tags SET name = ${name} WHERE id = ${tag.id}::uuid RETURNING id, name, created_by, created_at`);
      } catch (err) {
        if (pgCode(err) === '23505') throw nameTaken(name);
        throw err;
      }
      const bumped = await tx.$queryRaw<BumpedLead[]>(Prisma.sql`
        WITH upd AS (
          UPDATE companies c SET version = c.version + 1 WHERE c.id = ANY(${leads.map((l) => l.id)}::uuid[])
          RETURNING c.id, c.version, c.assigned_rep_id
        ), evt AS (
          INSERT INTO outbox_events (event_type, company_id, payload)
          SELECT 'tags.changed', id, jsonb_build_object(
            'company_id', id, 'tag_id', ${tag.id}::uuid, 'tag_name', ${name}::text, 'previous_name', ${tag.name}::text,
            'renamed', true, 'assigned_rep_id', assigned_rep_id, 'version', version, 'actor_type', 'user',
            'actor_id', ${actor.id}::uuid, 'actor_name', ${actor.name}::text)
          FROM upd
        )
        SELECT id AS "companyId", version, assigned_rep_id AS "assignedRepId" FROM upd ORDER BY id`);
      await auditTag(tx, actor, tag.id, 'renamed', { name: [tag.name, name] });
      await emit(tx, actor, 'tags.changed', null, { tag_id: tag.id, tag_name: name, previous_name: tag.name, renamed: true });
      return { tag: tagOut(renamed), previousName: tag.name, leads: visibleLeads(actor, bumped) } satisfies CustomTagUpdated;
    });
    res.json(out);
  });

  // Unlinks a tag from every lead as DELETE /leads/:id/custom-tags/:tagId does (version bump, activity row and
  // tags.changed event per lead), then deletes it, in one transaction.
  r.delete('/custom-tags/:id', async (req, res) => {
    const actor = actorOf(res);
    const id = parse(uuid, req.params.id);
    const out = await write(actor, async (tx) => {
      const { tag } = await lockTag(tx, actor, id);
      const removed = JSON.stringify({ id: tag.id, name: tag.name });
      const bumped = await tx.$queryRaw<BumpedLead[]>(Prisma.sql`
        WITH unlinked AS (
          DELETE FROM company_custom_tags WHERE tag_id = ${tag.id}::uuid RETURNING company_id
        ), upd AS (
          UPDATE companies c SET version = c.version + 1 FROM unlinked WHERE c.id = unlinked.company_id
          RETURNING c.id, c.version, c.assigned_rep_id
        ), act AS (
          INSERT INTO activity_logs (company_id, actor_type, user_id, action_type, field_diff, created_at)
          SELECT id, 'user', ${actor.id}::uuid, 'custom_tag',
                 jsonb_build_object('custom_tag', jsonb_build_array(${removed}::jsonb, NULL)), clock_timestamp()
          FROM upd
        ), evt AS (
          INSERT INTO outbox_events (event_type, company_id, payload)
          SELECT 'tags.changed', id, jsonb_build_object(
            'company_id', id, 'tag_id', ${tag.id}::uuid, 'tag_name', ${tag.name}::text, 'added', false, 'deleted', true,
            'assigned_rep_id', assigned_rep_id, 'version', version, 'actor_type', 'user', 'actor_id', ${actor.id}::uuid,
            'actor_name', ${actor.name}::text)
          FROM upd
        )
        SELECT id AS "companyId", version, assigned_rep_id AS "assignedRepId" FROM upd ORDER BY id`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM custom_tags WHERE id = ${tag.id}::uuid`);
      await auditTag(tx, actor, tag.id, 'deleted', { name: [tag.name, null], leads: bumped.length });
      await emit(tx, actor, 'tags.changed', null, { tag_id: tag.id, tag_name: tag.name, deleted: true });
      return { deleted: true, tagId: tag.id, name: tag.name, leads: visibleLeads(actor, bumped) } satisfies CustomTagDeleted;
    });
    res.json(out);
  });

  r.delete('/leads/:id/custom-tags/:tagId', async (req, res) => {
    const actor = actorOf(res);
    const tagId = parse(uuid, req.params.tagId);
    const out = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'update');
      const [removed] = await tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
        DELETE FROM company_custom_tags l USING custom_tags t
        WHERE l.company_id = ${lead.id}::uuid AND l.tag_id = ${tagId}::uuid AND t.id = l.tag_id
        RETURNING t.id, t.name`);
      if (!removed) throw notFound('tag_not_linked');
      const { version } = await bumpCompany(tx, lead.id);
      await logActivity(tx, actor, lead.id, 'custom_tag', { fieldDiff: { custom_tag: [removed, null] } });
      await emit(tx, actor, 'tags.changed', lead.id, {
        tag_id: removed.id, tag_name: removed.name, added: false, assigned_rep_id: lead.assigned_rep_id, version,
      });
      return { removed: true, tagId: removed.id, version } satisfies LeadTagRemoved;
    });
    res.json(out);
  });

  // One custom data slot per request, optimistic-locked on the lead version; null removes the key.
  r.put('/leads/:id/custom-fields/:key', async (req, res) => {
    const actor = actorOf(res);
    const key = parse(fieldKey, req.params.key);
    const body = parse(fieldBody, req.body);
    const out = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'update');
      const [cur] = await tx.$queryRaw<{ old: Json; present: boolean; n: number }[]>(Prisma.sql`
        SELECT custom_fields -> ${key} AS old, (custom_fields -> ${key}) IS NOT NULL AS present,
               (SELECT count(*)::int FROM jsonb_object_keys(custom_fields)) AS n
        FROM companies WHERE id = ${lead.id}::uuid`);
      if (lead.version !== body.version) throw await conflict(tx, { companyId: lead.id }, { key, value: cur.old });
      if (body.value !== null && !cur.present && cur.n >= MAX_CUSTOM_FIELDS) {
        throw badRequest('too_many_custom_fields', { max: MAX_CUSTOM_FIELDS });
      }
      const next = body.value === null
        ? Prisma.sql`custom_fields - ${key}`
        : Prisma.sql`custom_fields || jsonb_build_object(${key}::text, ${JSON.stringify(body.value)}::jsonb)`;
      const [row] = await tx.$queryRaw<{ version: number; custom_fields: Record<string, Json> }[]>(Prisma.sql`
        UPDATE companies SET custom_fields = ${next}, version = version + 1
        WHERE id = ${lead.id}::uuid RETURNING version, custom_fields`);
      await logActivity(tx, actor, lead.id, 'custom_field', { fieldDiff: { [`custom_fields.${key}`]: [cur.old, body.value] } });
      await emit(tx, actor, 'lead.updated', lead.id, {
        fields: [`custom_fields.${key}`], assigned_rep_id: lead.assigned_rep_id, version: row.version,
      });
      return { key, value: body.value, customFields: row.custom_fields, version: row.version } satisfies CustomFieldSet;
    });
    res.json(out);
  });

  return r;
}
