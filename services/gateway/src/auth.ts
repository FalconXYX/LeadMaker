import { isUuid } from '@leadmaker/shared';
import type { NextFunction, Request, Response } from 'express';
import { errors, jwtVerify, SignJWT } from 'jose';
import type { AuthUser } from './types.ts';

const ISSUER = 'leadmaker-gateway';
const AUDIENCE = 'leadmaker';

export type Tokens = {
  sign(user: AuthUser): Promise<string>;
  verify(token: string): Promise<AuthUser & { exp: number }>;
};

export function tokens(secret: string, ttl: string): Tokens {
  const key = new TextEncoder().encode(secret);
  return {
    sign: (user) =>
      new SignJWT({ role: user.role, name: user.name })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(ttl)
        .sign(key),
    async verify(token) {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
      const { sub, role, name, exp } = payload;
      if (!isUuid(sub) || (role !== 'rep' && role !== 'manager') || typeof name !== 'string' || typeof exp !== 'number') {
        throw new errors.JWTClaimValidationFailed('unexpected claims', payload);
      }
      return { id: sub, role, name, exp };
    },
  };
}

/** Bearer header, or ?access_token= where allowed (EventSource cannot set headers). */
function bearer(req: Request, allowQuery: boolean): string | undefined {
  const h = req.headers.authorization;
  if (h) {
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    return m?.[1];
  }
  const q = req.query.access_token;
  return allowQuery && typeof q === 'string' ? q : undefined;
}

export function requireAuth(t: Tokens, opts: { allowQueryToken?: (req: Request) => boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req, opts.allowQueryToken?.(req) ?? false);
    if (!token) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthenticated' });
      return;
    }
    try {
      const { exp, ...user } = await t.verify(token);
      req.user = user;
      res.locals.tokenExp = exp;
      next();
    } catch {
      res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').json({ error: 'invalid_token' });
    }
  };
}
