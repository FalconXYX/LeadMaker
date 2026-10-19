// Allocation-only API calls (bulk return to the pool) and the service limits (GET /api/config).
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { BulkUnallocateResult, ConfigResponse } from '@/api/types';

type Opts = { signal?: AbortSignal };

/** DELETE /api/allocations {companyIds}: back to the pool in one transaction (at most config.maxBulkUnallocate). */
export const unallocateLeads = (companyIds: string[]) =>
  api.delete<BulkUnallocateResult>('/api/allocations', { body: { companyIds } });

/** GET /api/config: the limits the services enforce. */
export const getConfig = (o?: Opts) => api.get<ConfigResponse>('/api/config', o);

/** Shared with every other reader of /api/config (one request per session). */
export const configKey = ['config'] as const;

const configQuery = {
  queryKey: configKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => getConfig({ signal }),
  staleTime: 10 * 60_000,
};

export interface AllocationLimits {
  /** Most leads one POST /api/allocations or /by-filter may move. */
  maxBulkAllocation: number;
  /** Most leads one DELETE /api/allocations may return to the pool. */
  maxBulkUnallocate: number;
}

function limitsOf(c: Partial<ConfigResponse> | undefined): AllocationLimits | null {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const alloc = n(c?.maxBulkAllocation);
  const unalloc = n(c?.maxBulkUnallocate);
  return alloc && unalloc ? { maxBulkAllocation: alloc, maxBulkUnallocate: unalloc } : null;
}

/** The limits once /api/config has answered; null until then (the server still enforces them). */
export function useAllocationLimits(): AllocationLimits | null {
  const q = useQuery(configQuery);
  return limitsOf(q.data);
}

/**
 * The limits for a write: from the cache, else fetched. Null when /api/config cannot be read: the write then
 * goes in one request and the server's own check answers.
 */
export async function ensureAllocationLimits(qc: QueryClient): Promise<AllocationLimits | null> {
  try {
    return limitsOf(await qc.ensureQueryData(configQuery));
  } catch {
    return null;
  }
}
