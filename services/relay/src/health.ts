import http from 'node:http';
import type { ConsumerStats } from './invalidation.ts';
import type { KpiStats } from './kpis.ts';
import type { PublisherStats } from './outbox.ts';

export type HealthSources = {
  publisher: PublisherStats;
  consumer: ConsumerStats;
  kpis: KpiStats;
  startedAt: Date;
  /** A loop counts as stuck when it has not succeeded for this long. */
  staleAfterMs: number;
};

export function healthReport(s: HealthSources, now = Date.now()) {
  const fresh = (at: Date | null) => (at ? now - at.getTime() : now - s.startedAt.getTime()) < s.staleAfterMs;
  const publisher = fresh(s.publisher.lastSuccessAt);
  const consumer = fresh(s.consumer.lastReadAt);
  return {
    status: publisher && consumer ? 'ok' : 'degraded',
    publisher: { ok: publisher, ...s.publisher },
    consumer: { ok: consumer, ...s.consumer },
    kpis: s.kpis,
  };
}

/** GET /healthz (and /readyz): 200 while the publisher and consumer loops are making progress, else 503. */
export function healthServer(sources: HealthSources): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/healthz' && req.url !== '/readyz')) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not_found"}');
      return;
    }
    const report = healthReport(sources);
    res.writeHead(report.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(report));
  });
}
