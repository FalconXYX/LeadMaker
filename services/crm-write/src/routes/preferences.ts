import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import type { UserPreferences } from '@leadmaker/shared';
import { actorOf } from '../auth.ts';
import { HttpError, parse } from '../http.ts';
import type { Deps } from '../app.ts';

export const MAX_PREFS_BYTES = 64 * 1024;

const prefsBody = z.object({
  prefs: z.record(z.string(), z.unknown())
    .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= MAX_PREFS_BYTES, `at most ${MAX_PREFS_BYTES} bytes of JSON`),
  version: z.int().min(0),
}).strict();

type Row = { prefs: Record<string, unknown>; version: number; updated_at: Date };
const out = (r: Row): UserPreferences => ({ prefs: r.prefs, version: r.version, updatedAt: r.updated_at.toISOString() });

export function preferenceRoutes({ write }: Deps): Router {
  const r = Router();

  // Replaces the caller's preferences document, optimistic-locked on its version (0 before the first save).
  r.put('/preferences', async (req, res) => {
    const actor = actorOf(res);
    const body = parse(prefsBody, req.body);
    const json = JSON.stringify(body.prefs);
    const saved = await write(actor, async (tx) => {
      const [row] = body.version === 0
        ? await tx.$queryRaw<Row[]>(Prisma.sql`
            INSERT INTO user_preferences (user_id, prefs) VALUES (${actor.id}::uuid, ${json}::jsonb)
            ON CONFLICT (user_id) DO NOTHING RETURNING prefs, version, updated_at`)
        : await tx.$queryRaw<Row[]>(Prisma.sql`
            UPDATE user_preferences SET prefs = ${json}::jsonb, version = version + 1, updated_at = now()
            WHERE user_id = ${actor.id}::uuid AND version = ${body.version} RETURNING prefs, version, updated_at`);
      if (row) return out(row);
      const [cur] = await tx.$queryRaw<Row[]>(Prisma.sql`
        SELECT prefs, version, updated_at FROM user_preferences WHERE user_id = ${actor.id}::uuid`);
      throw new HttpError(409, {
        error: 'version_conflict',
        current: { version: cur?.version ?? 0, prefs: cur?.prefs ?? {} },
        changedBy: cur ? { id: actor.id, name: actor.name } : null,
        changedAt: cur?.updated_at.toISOString() ?? null,
      });
    });
    res.json(saved);
  });

  return r;
}
