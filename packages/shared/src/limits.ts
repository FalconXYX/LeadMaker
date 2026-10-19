// Request limits read from the environment by the service that enforces them (crm-write) and by the gateway,
// which reports them on GET /api/config, so both always agree.
import type { ConfigResponse } from './types.ts';

export const DEFAULT_MAX_BULK_ALLOCATION = 5000;
export const DEFAULT_MAX_BULK_TAG = 500;
export const DEFAULT_USER_JOBS_PER_HOUR = 20;
/** Calls, emails and visits per rep per week (the dashboard's goal). */
export const DEFAULT_WEEKLY_ACTIVITY_GOAL = 25;
/** DELETE /api/allocations takes at most this many leads (fewer when MAX_BULK_ALLOCATION is lower). */
export const MAX_BULK_UNALLOCATE = 500;

export function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
  return n;
}

export type Limits = Omit<ConfigResponse, 'userRoleTtlSeconds'>;

/**
 * MAX_BULK_ALLOCATION, MAX_BULK_TAG, LEADMAKER_USER_JOBS_PER_HOUR (shared with the Python worker; <= 0 disables
 * the hourly refresh limit, reported as 0) and WEEKLY_ACTIVITY_GOAL.
 */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  const maxBulkAllocation = intEnv(env, 'MAX_BULK_ALLOCATION', DEFAULT_MAX_BULK_ALLOCATION, 1);
  return {
    maxBulkAllocation,
    maxBulkTag: intEnv(env, 'MAX_BULK_TAG', DEFAULT_MAX_BULK_TAG, 1),
    maxBulkUnallocate: Math.min(MAX_BULK_UNALLOCATE, maxBulkAllocation),
    refreshPerHour: Math.max(0, intEnv(env, 'LEADMAKER_USER_JOBS_PER_HOUR', DEFAULT_USER_JOBS_PER_HOUR, Number.MIN_SAFE_INTEGER)),
    weeklyActivityGoal: weeklyActivityGoal(env),
  };
}

/** WEEKLY_ACTIVITY_GOAL (default 25): ConfigResponse.weeklyActivityGoal and the dashboard's goal per rep. */
export function weeklyActivityGoal(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, 'WEEKLY_ACTIVITY_GOAL', DEFAULT_WEEKLY_ACTIVITY_GOAL, 1);
}
