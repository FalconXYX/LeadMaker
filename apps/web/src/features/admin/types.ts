// The admin contract (GET/POST/PATCH/DELETE /api/admin/territories, POST .../:id/run, GET /api/admin/runs),
// re-exported from packages/shared/src/admin.ts through the type-only bridge in '@/api/types'.
import type { Run, TerritoryCreate, TerritoryRunResult } from '@/api/types';

export type { RunStatus, Territory, Run, TerritoryPatch } from '@/api/types';

/** POST /api/admin/territories body; PATCH takes any subset. */
export type TerritoryInput = TerritoryCreate;

/** Found / new / updated counts of one run (null on runs recorded before the worker counted them). */
export type RunStats = NonNullable<Run['stats']>;

/** POST /api/admin/territories/:id/run: 202, the queued job (or the open one for the same area). */
export type RunStarted = TerritoryRunResult;
