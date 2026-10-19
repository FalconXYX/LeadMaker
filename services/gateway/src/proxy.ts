import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import type { Request, Response } from 'express';

export type Upstream = 'query' | 'crm-write' | 'notifier' | 'assistant';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * /api/assistant* goes to the assistant (GET, HEAD, POST only) and /api/notifications* to the notifier; otherwise
 * reads (GET, and POST /api/leads/search and /facets) go to the query service and every other write to crm-write.
 */
export function upstreamFor(method: string, path: string): Upstream | null {
  if (!path.startsWith('/api/')) return null;
  if (path === '/api/assistant' || path.startsWith('/api/assistant/')) {
    return method === 'GET' || method === 'HEAD' || method === 'POST' ? 'assistant' : null;
  }
  if (path === '/api/notifications' || path.startsWith('/api/notifications/')) return METHODS.has(method) ? 'notifier' : null;
  if (method === 'GET' || method === 'HEAD') return 'query';
  if (method === 'POST' && (path === '/api/leads/search' || path === '/api/leads/facets')) return 'query';
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return 'crm-write';
  return null;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

// Identity and routing headers only the gateway may set; the client's copies are dropped, never merged.
const GATEWAY_OWNED = /^(x-user-|x-internal-|x-forwarded-|x-real-ip$|x-request-id$|forwarded$|host$|authorization$|cookie$)/;

export type Identity = { userId: string; role: string; internalToken: string; requestId: string; clientIp: string };

export function upstreamHeaders(incoming: IncomingHttpHeaders, id: Identity, host: string): OutgoingHttpHeaders {
  const listed = new Set(
    String(incoming.connection ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key) || listed.has(key) || GATEWAY_OWNED.test(key)) continue;
    out[key] = value;
  }
  // A body without Content-Length goes upstream chunked too: Node frames only some methods' bodies by default
  // (not DELETE's), and unframed bytes would be read as the next request on the keep-alive socket.
  if (incoming['content-length'] === undefined && incoming['transfer-encoding'] !== undefined) out['transfer-encoding'] = 'chunked';
  out.host = host;
  out['x-user-id'] = id.userId;
  out['x-user-role'] = id.role;
  out['x-internal-token'] = id.internalToken;
  out['x-request-id'] = id.requestId;
  out['x-forwarded-for'] = id.clientIp;
  return out;
}

function responseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && name !== 'x-request-id') out[name] = value;
  }
  return out;
}

export type ProxyOptions = {
  targets: Record<Upstream, string>;
  internalToken: string;
  /** Deadline for the whole upstream exchange; on expiry the upstream request is aborted and the client gets 504. */
  timeoutMs: number;
  /** Per-upstream deadlines that replace timeoutMs (the assistant streams answers for longer). */
  timeouts?: Partial<Record<Upstream, number>>;
  maxBodyBytes: number;
};

/**
 * Streams the request to its upstream service with the caller's identity attached. The upstream request is
 * destroyed when the client goes away or the deadline passes, so the service sees the close and drops the work.
 */
export function proxy(opts: ProxyOptions) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const targets = Object.fromEntries(
    Object.entries(opts.targets).map(([k, v]) => [k, new URL(v)]),
  ) as Record<Upstream, URL>;

  return (req: Request, res: Response) => {
    const upstream = upstreamFor(req.method, new URL(req.originalUrl, 'http://gateway').pathname);
    if (!upstream) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > opts.maxBodyBytes) {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    const target = targets[upstream];
    const user = req.user!;
    const upstreamReq = http.request({
      agent,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.originalUrl,
      headers: upstreamHeaders(req.headers, {
        userId: user.id,
        role: user.role,
        internalToken: opts.internalToken,
        requestId: req.id,
        clientIp: req.ip ?? '',
      }, target.host),
    });
    const deadline = setTimeout(
      () => upstreamReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })),
      opts.timeouts?.[upstream] ?? opts.timeoutMs,
    );

    upstreamReq.on('response', (upstreamRes) => {
      res.status(upstreamRes.statusCode ?? 502);
      for (const [name, value] of Object.entries(responseHeaders(upstreamRes.headers))) res.setHeader(name, value!);
      // An event stream (the assistant's answer) is forwarded as it arrives: headers now, no Nagle delay.
      if (String(upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')) {
        res.flushHeaders();
        res.socket?.setNoDelay(true);
      }
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    });
    // Content-Length was checked above; a chunked body is counted as it streams.
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received <= opts.maxBodyBytes || tooLarge) return;
      tooLarge = true;
      req.unpipe(upstreamReq);
      upstreamReq.destroy();
      if (res.headersSent) res.destroy();
      else res.status(413).set('Connection', 'close').json({ error: 'payload_too_large' });
    });
    upstreamReq.on('error', (err: NodeJS.ErrnoException) => {
      if (tooLarge) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (res.destroyed) return;
      req.log.warn({ err: { message: err.message, code: err.code }, upstream }, 'upstream request failed');
      const timedOut = err.code === 'ETIMEDOUT';
      res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'upstream_timeout' : 'upstream_unavailable', upstream });
    });
    res.on('close', () => {
      clearTimeout(deadline);
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  };
}
