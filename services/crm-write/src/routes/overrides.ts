import { Router, type Request } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import type { CompanyOverrideField, ContactOverrideField, FieldOverride, OverrideResult } from '@leadmaker/shared';
import { actorOf, type Actor } from '../auth.ts';
import { badRequest, isUuid, notFound, parse } from '../http.ts';
import { bumpCompany, conflict, emit, lockLead, logActivity, type Json, type LeadRow, type Tx } from '../tx.ts';
import type { Deps } from '../app.ts';

// Rep edits live in field_overrides (never written by the pipeline); the read layer shows the active
// override, else the scraped value, and flags "source changed" when the scraped value no longer
// equals scraped_value_at_edit. Only the shared COMPANY_/CONTACT_OVERRIDE_FIELDS can be overridden;
// the maps are typed by those lists, so adding a field there fails typecheck until it is validated here.
const text = (max: number) => z.string().trim().min(1).max(max);
const COMPANY_FIELDS: Record<CompanyOverrideField, z.ZodType<Json>> = {
  business_name: text(255),
  phone: text(32).nullable(),
  website_url: z.url({ protocol: /^https?$/ }).max(2048).nullable(),
  address: text(512).nullable(),
  street: text(255).nullable(),
  city: text(128).nullable(),
  state: text(8).nullable(),
  postal_code: text(16).nullable(),
};
const CONTACT_FIELDS: Record<ContactOverrideField, z.ZodType<Json>> = {
  name: text(255).nullable(),
  title: text(255).nullable(),
  email: z.email().max(255).nullable(),
  phone: text(64).nullable(),
  do_not_contact: z.boolean(),
};

type Field = { name: string; schema: z.ZodType<Json>; scraped: Prisma.Sql };

function resolveField(fields: Record<string, z.ZodType<Json>>, name: string): Field {
  if (!Object.hasOwn(fields, name)) throw badRequest('unknown_field', { field: name, allowed: Object.keys(fields) });
  // name is one of the fixed keys above, so it is safe as an identifier.
  return { name, schema: fields[name], scraped: Prisma.sql`to_jsonb(c.${Prisma.raw(`"${name}"`)})` };
}
const companyField = (name: string) => resolveField(COMPANY_FIELDS, name);
const contactField = (name: string) => resolveField(CONTACT_FIELDS, name);

const version = z.int().positive();
const putBody = z.object({ value: z.unknown(), version });

function parsePut(req: Request, field: Field): { value: Json; version: number } {
  const body = parse(putBody, req.body);
  if (!Object.hasOwn(body, 'value')) throw badRequest('invalid_request', { issues: [{ path: 'value', message: 'required' }] });
  return { value: parse(field.schema, body.value), version: body.version };
}

/** DELETE takes the version from the body or ?version=. */
export function parseDeleteVersion(req: Request): number {
  const raw = (req.body as { version?: unknown } | undefined)?.version ?? req.query.version;
  return parse(z.object({ version: z.coerce.number().pipe(version) }), { version: raw }).version;
}

type Target = { lead: LeadRow; contact: { id: string; version: number } | null };
type Current = { scraped: Json; override_id: string | null; override_value: Json; override_user: string | null };

async function lockTarget(tx: Tx, actor: Actor, kind: 'company' | 'contact', id: string): Promise<Target> {
  if (kind === 'company') return { lead: await lockLead(tx, id, actor, 'update'), contact: null };
  if (!isUuid(id)) throw notFound();
  // company_id comes from the contact row, never the client; company is locked first (same order as every writer).
  const [owner] = await tx.$queryRaw<{ company_id: string }[]>(Prisma.sql`
    SELECT company_id FROM contacts WHERE id = ${id}::uuid`);
  if (!owner) throw notFound();
  const lead = await lockLead(tx, owner.company_id, actor, 'update');
  const [contact] = await tx.$queryRaw<{ id: string; version: number }[]>(Prisma.sql`
    SELECT id, version FROM contacts WHERE id = ${id}::uuid AND company_id = ${lead.id}::uuid FOR NO KEY UPDATE`);
  if (!contact) throw notFound();
  return { lead, contact };
}

async function currentValue(tx: Tx, t: Target, field: Field): Promise<Current> {
  const [row] = t.contact
    ? await tx.$queryRaw<Current[]>(Prisma.sql`
        SELECT ${field.scraped} AS scraped, o.id AS override_id, o.value AS override_value, o.user_id AS override_user
        FROM contacts c LEFT JOIN field_overrides o
          ON o.contact_id = c.id AND o.field = ${field.name} AND o.superseded_at IS NULL
        WHERE c.id = ${t.contact.id}::uuid`)
    : await tx.$queryRaw<Current[]>(Prisma.sql`
        SELECT ${field.scraped} AS scraped, o.id AS override_id, o.value AS override_value, o.user_id AS override_user
        FROM companies c LEFT JOIN field_overrides o
          ON o.company_id = c.id AND o.contact_id IS NULL AND o.field = ${field.name} AND o.superseded_at IS NULL
        WHERE c.id = ${t.lead.id}::uuid`);
  return row;
}

const effective = (cur: Current): Json => (cur.override_id ? cur.override_value : cur.scraped);

/**
 * Sets (value) or clears (undefined) the field's override after checking the version the client
 * read, superseding the active override in the same transaction (at most one active per field).
 */
async function applyOverride(
  tx: Tx, actor: Actor, kind: 'company' | 'contact', id: string, field: Field, seen: number, value?: Json,
) {
  const t = await lockTarget(tx, actor, kind, id);
  const cur = await currentValue(tx, t, field);
  const targetVersion = t.contact ? t.contact.version : t.lead.version;
  if (targetVersion !== seen) {
    throw await conflict(tx, { companyId: t.lead.id, contactId: t.contact?.id }, {
      field: field.name, value: effective(cur), scrapedValue: cur.scraped, overridden: cur.override_id !== null,
    });
  }
  const clearing = value === undefined;
  if (clearing && !cur.override_id) throw notFound('override_not_found');
  if (cur.override_id) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE field_overrides SET superseded_at = now(), superseded_by = ${actor.id}::uuid
      WHERE id = ${cur.override_id}::uuid`);
  }
  let override: FieldOverride | null = null;
  if (!clearing) {
    const source = t.contact
      ? Prisma.sql`FROM contacts c WHERE c.id = ${t.contact.id}::uuid`
      : Prisma.sql`FROM companies c WHERE c.id = ${t.lead.id}::uuid`;
    const [row] = await tx.$queryRaw<{ id: string; scraped_value_at_edit: Json; created_at: Date }[]>(Prisma.sql`
      INSERT INTO field_overrides (company_id, contact_id, field, value, scraped_value_at_edit, user_id)
      SELECT ${t.lead.id}::uuid, ${t.contact?.id ?? null}::uuid, ${field.name}, ${JSON.stringify(value)}::jsonb,
             ${field.scraped}, ${actor.id}::uuid
      ${source}
      RETURNING id, scraped_value_at_edit, created_at`);
    override = {
      id: row.id, companyId: t.lead.id, contactId: t.contact?.id ?? null, field: field.name, value,
      scrapedValueAtEdit: row.scraped_value_at_edit, userId: actor.id, userName: actor.name,
      createdAt: row.created_at.toISOString(),
    };
  }
  let contactVersion: number | null = null;
  if (t.contact) {
    [{ version: contactVersion }] = await tx.$queryRaw<{ version: number }[]>(Prisma.sql`
      UPDATE contacts SET version = version + 1 WHERE id = ${t.contact.id}::uuid RETURNING version`);
  }
  const { version: companyVersion } = await bumpCompany(tx, t.lead.id);
  const newValue = clearing ? cur.scraped : value;
  await logActivity(tx, actor, t.lead.id, 'override', {
    fieldDiff: {
      [field.name]: [effective(cur), newValue],
      ...(t.contact ? { contact_id: t.contact.id } : {}),
      ...(clearing ? { cleared: true } : {}),
    },
  });
  await emit(tx, actor, 'override.set', t.lead.id, {
    contact_id: t.contact?.id ?? null, field: field.name, cleared: clearing,
    assigned_rep_id: t.lead.assigned_rep_id, version: companyVersion, contact_version: contactVersion,
  });
  return {
    field: field.name,
    value: newValue,
    override,
    version: contactVersion ?? companyVersion,
    companyVersion,
    ...(contactVersion !== null ? { contactVersion } : {}),
  } satisfies OverrideResult;
}

export function overrideRoutes({ write }: Deps): Router {
  const r = Router();
  const kinds = [['leads', 'company', companyField], ['contacts', 'contact', contactField]] as const;
  for (const [path, kind, resolve] of kinds) {
    r.put(`/${path}/:id/overrides/:field`, async (req, res) => {
      const actor = actorOf(res);
      const field = resolve(req.params.field);
      const body = parsePut(req, field);
      res.json(await write(actor, (tx) => applyOverride(tx, actor, kind, req.params.id, field, body.version, body.value)));
    });
    r.delete(`/${path}/:id/overrides/:field`, async (req, res) => {
      const actor = actorOf(res);
      const field = resolve(req.params.field);
      const seen = parseDeleteVersion(req);
      res.json(await write(actor, (tx) => applyOverride(tx, actor, kind, req.params.id, field, seen)));
    });
  }
  return r;
}
