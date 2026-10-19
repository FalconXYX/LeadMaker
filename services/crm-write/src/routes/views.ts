import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import {
  canEditView, canSeeView, canShareView, leadFilterSchema, savedViewOut, type LeadFilter, type SavedViewDeleted,
  type SavedViewRow, type SavedViewWritten,
} from '@leadmaker/shared';
import { actorOf, type Actor } from '../auth.ts';
import { badRequest, forbidden, HttpError, notFound, parse, pgCode, uuid } from '../http.ts';
import type { Tx } from '../tx.ts';
import type { Deps } from '../app.ts';

const MAX_VIEWS_PER_USER = 200;
const viewName = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}]+$/u, 'must not contain control characters');
const sortSchema = leadFilterSchema.shape.sort.unwrap().nullable();
const fields = { name: viewName, filter: leadFilterSchema, sort: sortSchema.optional(), isShared: z.boolean().optional() };
const createBody = z.object(fields).strict();
const updateBody = z.object(fields).partial().strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change');

type Sort = NonNullable<LeadFilter['sort']>;
type ViewRow = SavedViewRow & { sort: Sort | null };

const COLUMNS = Prisma.sql`v.id, v.user_id, u.name AS owner_name, v.name, v.filter, v.sort, v.is_shared, v.created_at, v.updated_at`;

/** The stored filter (no cursor: page state) and the sort column; an absent sort falls back to filter.sort. */
function split(filter: LeadFilter, sort: Sort | null | undefined): { filter: LeadFilter; sort: Sort | null } {
  const { cursor: _cursor, sort: inner, ...rest } = filter;
  const out = { filter: rest, sort: sort === undefined ? inner ?? null : sort };
  if (out.sort?.by === 'distance' && !out.filter.near) {
    throw badRequest('invalid_request', { issues: [{ path: 'sort.by', message: 'sort by distance needs near' }] });
  }
  return out;
}

const nameTaken = (name: string) => new HttpError(409, { error: 'name_taken', details: { name } });

async function saved(tx: Tx, id: string): Promise<ViewRow> {
  const [row] = await tx.$queryRaw<ViewRow[]>(Prisma.sql`
    SELECT ${COLUMNS} FROM saved_views v JOIN users u ON u.id = v.user_id WHERE v.id = ${id}::uuid`);
  return row;
}

/** A unique (user_id, name) clash raised by the statement is 409; the transaction is rolled back either way. */
async function named<T>(name: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (pgCode(err) === '23505' && name !== undefined) throw nameTaken(name);
    throw err;
  }
}

export function viewRoutes({ write }: Deps): Router {
  const r = Router();

  r.post('/views', async (req, res) => {
    const actor = actorOf(res);
    const body = parse(createBody, req.body);
    if (body.isShared && !canShareView(actor)) throw forbidden('only managers may share a view');
    const { filter, sort } = split(body.filter, body.sort);
    const view = await write(actor, async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`views:${actor.id}`}, 0))`);
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT count(*)::int AS n FROM saved_views WHERE user_id = ${actor.id}::uuid`);
      if (n >= MAX_VIEWS_PER_USER) throw badRequest('too_many_views', { max: MAX_VIEWS_PER_USER });
      const [{ id }] = await named(body.name, () => tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO saved_views (user_id, name, filter, sort, is_shared)
        VALUES (${actor.id}::uuid, ${body.name}, ${JSON.stringify(filter)}::jsonb, ${sort ? JSON.stringify(sort) : null}::jsonb,
                ${body.isShared ?? false})
        RETURNING id`));
      return savedViewOut(actor, await saved(tx, id));
    });
    res.status(201).json({ view } satisfies SavedViewWritten);
  });

  // Changes the given fields. Its owner may change a view, any manager a shared one; only managers may share.
  r.patch('/views/:id', async (req, res) => {
    const actor = actorOf(res);
    const id = parse(uuid, req.params.id);
    const body = parse(updateBody, req.body);
    if (body.isShared && !canShareView(actor)) throw forbidden('only managers may share a view');
    const view = await write(actor, async (tx) => {
      const cur = await lockView(tx, actor, id);
      const next = split(body.filter ?? cur.filter, body.sort !== undefined ? body.sort : body.filter?.sort ?? cur.sort);
      await named(body.name, () => tx.$executeRaw(Prisma.sql`
        UPDATE saved_views SET name = ${body.name ?? cur.name}, filter = ${JSON.stringify(next.filter)}::jsonb,
          sort = ${next.sort ? JSON.stringify(next.sort) : null}::jsonb, is_shared = ${body.isShared ?? cur.is_shared},
          updated_at = now()
        WHERE id = ${id}::uuid`));
      return savedViewOut(actor, await saved(tx, id));
    });
    res.json({ view } satisfies SavedViewWritten);
  });

  r.delete('/views/:id', async (req, res) => {
    const actor = actorOf(res);
    const id = parse(uuid, req.params.id);
    await write(actor, async (tx) => {
      await lockView(tx, actor, id);
      await tx.$executeRaw(Prisma.sql`DELETE FROM saved_views WHERE id = ${id}::uuid`);
    });
    res.json({ deleted: true, id } satisfies SavedViewDeleted);
  });

  return r;
}

/** A view the actor cannot see is 404; one they can see but not change (another user's shared view) is 403. */
async function lockView(tx: Tx, actor: Actor, id: string): Promise<ViewRow> {
  const [v] = await tx.$queryRaw<ViewRow[]>(Prisma.sql`
    SELECT ${COLUMNS} FROM saved_views v JOIN users u ON u.id = v.user_id WHERE v.id = ${id}::uuid FOR UPDATE OF v`);
  const ref = v && { ownerId: v.user_id, isShared: v.is_shared };
  if (!v || !canSeeView(actor, ref)) throw notFound('view_not_found');
  if (!canEditView(actor, ref)) throw forbidden('only its owner or a manager may change a shared view');
  return v;
}
