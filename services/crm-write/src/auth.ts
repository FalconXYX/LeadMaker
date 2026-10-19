import type { RequestHandler, Response } from 'express';
import { Prisma, type PrismaClient } from '@leadmaker/db';
import { authenticateInternal, canAllocate, type Viewer } from '@leadmaker/shared';
import { forbidden, unauthorized } from './http.ts';

export type Actor = Viewer & { name: string };

/**
 * Only the gateway may call this service: X-Internal-Token must match, and X-User-Id / X-User-Role
 * carry the verified JWT's user. The role is then taken from the users row, so a demoted manager
 * loses manager writes before their token expires, and a deleted user cannot write at all.
 */
export function authenticate(db: PrismaClient, token: string): RequestHandler {
  return async (req, res, next) => {
    const auth = authenticateInternal(req.headers, token);
    if (!auth.ok) throw unauthorized(auth.error);
    const [user] = await db.$queryRaw<Actor[]>(Prisma.sql`
      SELECT id, role, name FROM users WHERE id = ${auth.viewer.id}::uuid`);
    if (!user) throw unauthorized('unknown user');
    res.locals.actor = user;
    next();
  };
}

export const actorOf = (res: Response): Actor => res.locals.actor as Actor;

export function requireManager(actor: Actor): void {
  if (!canAllocate(actor)) throw forbidden('managers only');
}
