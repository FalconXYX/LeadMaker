import { DEFAULT_USER_JOBS_PER_HOUR, intEnv, internalToken, limitsFromEnv } from '@leadmaker/shared';

export type Config = {
  port: number;
  internalToken: string;
  redisUrl: string | null;
  /** On-demand refresh jobs per user per rolling hour (LEADMAKER_USER_JOBS_PER_HOUR, shared with Python); <= 0 disables. */
  userJobsPerHour: number;
  /** Most leads one allocation request may move. */
  maxBulkAllocation: number;
  /** Most leads one bulk tag request may tag (MAX_BULK_TAG). */
  maxBulkTag: number;
  /** Most leads one bulk unallocation may return to the pool. */
  maxBulkUnallocate: number;
  logLevel: string;
  /** Queue an insights job when an edit changes a lead's AI inputs (LEADMAKER_INSIGHTS_ON_EDIT=1). */
  insightsOnEdit: { enabled: boolean; delaySeconds: number };
  /** Profile "Refresh" requests per user per rolling day (LEADMAKER_MANUAL_INSIGHTS_PER_USER_PER_DAY); <= 0 disables. */
  manualInsightsPerUserPerDay: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  // The same reader as the gateway's GET /api/config.
  const { maxBulkAllocation, maxBulkTag, maxBulkUnallocate } = limitsFromEnv(env);
  return {
    port: intEnv(env, 'PORT', 8082, 1),
    internalToken: internalToken(env),
    redisUrl: env.REDIS_URL || (production ? null : 'redis://localhost:56379'),
    userJobsPerHour: intEnv(env, 'LEADMAKER_USER_JOBS_PER_HOUR', DEFAULT_USER_JOBS_PER_HOUR, Number.MIN_SAFE_INTEGER),
    maxBulkAllocation,
    maxBulkTag,
    maxBulkUnallocate,
    logLevel: env.LOG_LEVEL ?? 'info',
    insightsOnEdit: {
      enabled: env.LEADMAKER_INSIGHTS_ON_EDIT === '1',
      delaySeconds: intEnv(env, 'LEADMAKER_INSIGHTS_EDIT_DELAY_SECONDS', 60, 0),
    },
    manualInsightsPerUserPerDay: intEnv(env, 'LEADMAKER_MANUAL_INSIGHTS_PER_USER_PER_DAY', 30, Number.MIN_SAFE_INTEGER),
  };
}
