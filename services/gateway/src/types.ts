import type { Role } from '@leadmaker/shared';
import type { Logger } from 'pino';

export type { Role };

/** The authenticated caller, from verified JWT claims. */
export type AuthUser = { id: string; role: Role; name: string };

export type User = AuthUser & { email: string };

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: AuthUser;
    }
  }
}
