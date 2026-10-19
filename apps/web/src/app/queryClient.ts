import { QueryCache, QueryClient } from '@tanstack/react-query';
import { shouldRetry } from '@/api/client';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache(),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 30_000,
        // SSE keeps data fresh; refetch on focus only catches what the stream missed while asleep.
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
