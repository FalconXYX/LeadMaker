import { cacheKeys, USER_ROLE_TTL_SECONDS, type Role } from '@leadmaker/shared';
import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Directory } from './directory.ts';

/**
 * The caller's role as users has it now, not as the JWT minted it: a demoted manager loses manager reads,
 * and a deleted user every request, within the cache TTL.
 */
export interface Roles {
  /** null: the user no longer exists. Throws when the directory cannot answer. */
  current(userId: string): Promise<Role | null>;
}

const GONE = 'none';

export function cachedRoles(redis: Redis, directory: Directory, ttlSeconds = USER_ROLE_TTL_SECONDS): Roles {
  return {
    async current(userId) {
      const key = cacheKeys.userRole(userId);
      // Redis down: read the directory every time rather than trust the token's role.
      const cached = await redis.get(key).catch(() => null);
      if (cached === 'rep' || cached === 'manager') return cached;
      if (cached === GONE) return null;
      const role = (await directory.userById(userId))?.role ?? null;
      void redis.set(key, role ?? GONE, 'EX', ttlSeconds).catch(() => {});
      return role;
    },
  };
}

/** After requireAuth: swaps the token's role for the current one; 401 once the user is gone. */
export function currentRole(roles: Roles) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let role: Role | null;
    try {
      role = await roles.current(req.user!.id);
    } catch (err) {
      req.log.warn({ err }, 'role lookup failed');
      res.status(503).set('Retry-After', '1').json({ error: 'unavailable' });
      return;
    }
    if (!role) {
      res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').json({ error: 'invalid_token', message: 'user no longer exists' });
      return;
    }
    req.user = { ...req.user!, role };
    next();
  };
}

/** After currentRole: manager-only paths (/api/admin/*, the Territories page) answer 403 to reps before any upstream. */
export function managersOnly(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role === 'manager') {
    next();
    return;
  }
  res.status(403).json({ error: 'forbidden', message: 'managers only' });
}
