import type { PrismaClient } from '@leadmaker/db';
import { isUuid } from '@leadmaker/shared';
import type { User } from './types.ts';

/** The gateway's only database reads: users (login, /api/me) and lead ownership (SSE visibility). */
export interface Directory {
  userByEmail(email: string): Promise<User | null>;
  userById(id: string): Promise<User | null>;
  /** companyId -> assigned_rep_id (null = unallocated pool); unknown companies are absent. */
  assignments(companyIds: string[]): Promise<Map<string, string | null>>;
  /** companyId -> rep of its most recently ended allocation, for telling a rep a lead left them. */
  previousAssignees(companyIds: string[]): Promise<Map<string, string>>;
  ping(): Promise<void>;
}

const toUser = (u: { id: string; name: string; email: string; role: string }): User => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role === 'manager' ? 'manager' : 'rep',
});

export function prismaDirectory(db: PrismaClient): Directory {
  const select = { id: true, name: true, email: true, role: true } as const;
  return {
    async userByEmail(email) {
      // Exact, case-insensitive match; never a pattern (ILIKE would treat % and _ as wildcards).
      const [u] = await db.$queryRaw<{ id: string; name: string; email: string; role: string }[]>`
        SELECT id::text, name, email, role FROM users WHERE lower(email) = lower(${email}) LIMIT 1`;
      return u ? toUser(u) : null;
    },
    async userById(id) {
      if (!isUuid(id)) return null;
      const u = await db.users.findUnique({ where: { id }, select });
      return u && toUser(u);
    },
    async assignments(companyIds) {
      const ids = companyIds.filter(isUuid);
      if (!ids.length) return new Map();
      const rows = await db.companies.findMany({ where: { id: { in: ids } }, select: { id: true, assigned_rep_id: true } });
      return new Map(rows.map((r) => [r.id, r.assigned_rep_id]));
    },
    async previousAssignees(companyIds) {
      const ids = companyIds.filter(isUuid);
      if (!ids.length) return new Map();
      const rows = await db.$queryRaw<{ company_id: string; rep_id: string }[]>`
        SELECT DISTINCT ON (company_id) company_id::text, rep_id::text
        FROM lead_allocations
        WHERE company_id = ANY(${ids}::uuid[]) AND ended_at IS NOT NULL
        ORDER BY company_id, ended_at DESC`;
      return new Map(rows.map((r) => [r.company_id, r.rep_id]));
    },
    async ping() {
      await db.$queryRaw`SELECT 1`;
    },
  };
}
