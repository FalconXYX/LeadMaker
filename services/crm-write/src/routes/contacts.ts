import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import type { ContactCreated, ContactDeleted, RepContact } from '@leadmaker/shared';
import { actorOf } from '../auth.ts';
import { badRequest, forbidden, isUuid, notFound, parse } from '../http.ts';
import { bumpCompany, conflict, emit, lockLead, logActivity, type Json } from '../tx.ts';
import { parseDeleteVersion } from './overrides.ts';
import type { Deps } from '../app.ts';

// People a rep adds by hand: source 'rep' and no source_key. The pipeline upserts on source_key and
// prunes only its own enrichment sources, so it never updates, deletes or audits them. Their fields
// are then edited like any contact's, through field_overrides on the contact version.
export const REP_CONTACT_SOURCE = 'rep';
const MAX_REP_CONTACTS = 50;

// Forms send '' for an empty optional field; it means "not given".
const optional = <S extends z.ZodType>(schema: S) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim() || null : v), schema.nullish());
const createBody = z.object({
  name: z.string().trim().min(1).max(255),
  title: optional(z.string().max(255)),
  // contacts has no role column: the tagger reads a person's role from the title, so role is stored there.
  role: optional(z.string().max(255)),
  email: optional(z.email().max(255)),
  phone: optional(z.string().max(64)),
}).refine((b) => !b.title || !b.role || b.title === b.role, {
  path: ['role'], message: 'role is stored as the title; send one of them',
});

type ContactRow = {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  do_not_contact: boolean;
  source: string;
  confidence: number;
  first_seen_at: Date;
  version: number;
};
const COLUMNS = Prisma.raw('id, name, title, email, phone, do_not_contact, source, confidence, first_seen_at, version');

const contactOut = (c: ContactRow, companyId: string): RepContact => ({
  id: c.id, companyId, name: c.name, title: c.title, email: c.email, phone: c.phone, doNotContact: c.do_not_contact,
  source: c.source, confidence: c.confidence, version: c.version, createdAt: c.first_seen_at.toISOString(),
});

export function contactRoutes({ write }: Deps): Router {
  const r = Router();

  // A new contact bumps the lead version (profiles list contacts); the contact itself starts at version 1.
  r.post('/leads/:id/contacts', async (req, res) => {
    const actor = actorOf(res);
    const body = parse(createBody, req.body);
    const fields = {
      name: body.name, title: body.title ?? body.role ?? null, email: body.email ?? null, phone: body.phone ?? null,
    };
    const out = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'update');
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT count(*)::int AS n FROM contacts WHERE company_id = ${lead.id}::uuid AND source = ${REP_CONTACT_SOURCE}`);
      if (n >= MAX_REP_CONTACTS) throw badRequest('too_many_contacts', { max: MAX_REP_CONTACTS });
      const [contact] = await tx.$queryRaw<ContactRow[]>(Prisma.sql`
        INSERT INTO contacts (company_id, name, title, email, phone, source, confidence)
        VALUES (${lead.id}::uuid, ${fields.name}, ${fields.title}, ${fields.email}, ${fields.phone}, ${REP_CONTACT_SOURCE}, 1)
        RETURNING ${COLUMNS}`);
      const { version } = await bumpCompany(tx, lead.id);
      await logActivity(tx, actor, lead.id, 'contact', { fieldDiff: { contact: [null, fields], contact_id: contact.id } });
      await emit(tx, actor, 'lead.updated', lead.id, {
        fields: ['contacts'], contact_id: contact.id, assigned_rep_id: lead.assigned_rep_id, version,
      });
      return { contact: contactOut(contact, lead.id), version } satisfies ContactCreated;
    });
    res.status(201).json(out);
  });

  // Hard delete, rep-added contacts only, checked against the contact version like an override clear.
  // The activity row keeps what the contact showed (overrides applied); its overrides cascade away.
  r.delete('/contacts/:id', async (req, res) => {
    const actor = actorOf(res);
    const seen = parseDeleteVersion(req);
    const id = req.params.id;
    const out = await write(actor, async (tx) => {
      if (!isUuid(id)) throw notFound();
      const [owner] = await tx.$queryRaw<{ company_id: string }[]>(Prisma.sql`
        SELECT company_id FROM contacts WHERE id = ${id}::uuid`);
      if (!owner) throw notFound();
      const lead = await lockLead(tx, owner.company_id, actor, 'update');
      const [contact] = await tx.$queryRaw<(ContactRow & { overrides: Record<string, Json> })[]>(Prisma.sql`
        SELECT ${COLUMNS}, COALESCE((SELECT jsonb_object_agg(o.field, o.value) FROM field_overrides o
                                      WHERE o.contact_id = c.id AND o.superseded_at IS NULL), '{}') AS overrides
        FROM contacts c WHERE c.id = ${id}::uuid AND c.company_id = ${lead.id}::uuid FOR UPDATE`);
      if (!contact) throw notFound();
      if (contact.source !== REP_CONTACT_SOURCE) throw forbidden('only contacts added by a rep can be deleted');
      const shown: Record<string, Json> = {
        name: contact.name, title: contact.title, email: contact.email, phone: contact.phone,
        do_not_contact: contact.do_not_contact, ...contact.overrides,
      };
      if (contact.version !== seen) {
        throw await conflict(tx, { companyId: lead.id, contactId: contact.id }, { contact: shown });
      }
      await tx.$executeRaw(Prisma.sql`DELETE FROM contacts WHERE id = ${contact.id}::uuid`);
      const { version } = await bumpCompany(tx, lead.id);
      await logActivity(tx, actor, lead.id, 'contact', { fieldDiff: { contact: [shown, null], contact_id: contact.id } });
      await emit(tx, actor, 'lead.updated', lead.id, {
        fields: ['contacts'], contact_id: contact.id, deleted: true, assigned_rep_id: lead.assigned_rep_id, version,
      });
      return { deleted: true, contactId: contact.id, version } satisfies ContactDeleted;
    });
    res.json(out);
  });

  return r;
}
