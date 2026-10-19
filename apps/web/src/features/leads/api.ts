// Service limits for the lead list (GET /api/config via the shared useConfig), with the services' defaults
// while it loads or when it fails, so a cap is never undefined.
import { useConfig } from '@/api/queries';
import type { TaskCreate } from '@/api/types';

export type { TaskCreate };

/** Used until GET /api/config answers (the services' defaults). */
export const DEFAULT_LIMITS = { maxBulkTag: 500, maxBulkAllocation: 5000, maxBulkUnallocate: 500 } as const;

export function useLimits() {
  const q = useConfig();
  const n = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  return {
    maxBulkTag: n(q.data?.maxBulkTag, DEFAULT_LIMITS.maxBulkTag),
    maxBulkAllocation: n(q.data?.maxBulkAllocation, DEFAULT_LIMITS.maxBulkAllocation),
    maxBulkUnallocate: n(q.data?.maxBulkUnallocate, DEFAULT_LIMITS.maxBulkUnallocate),
  };
}

