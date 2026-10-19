// /api/assistant/* through the proxy: routing, incremental SSE forwarding, the assistant's own deadline, identity
// headers and the "assistant down" answer the drawer reads as offline.
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { requestLogger } from '../src/logger.ts';
import { proxy } from '../src/proxy.ts';

const REP = { id: '11111111-1111-4111-8111-111111111111', role: 'rep' as const, name: 'Rep' };
const OTHER = '22222222-2222-4222-8222-222222222222';

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An assistant stand-in: /api/assistant/chat streams 3 SSE chunks `gapMs` apart; records what it was sent. */
async function fakeAssistant(gapMs: number) {
  const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  const writtenAt: number[] = [];
  const url = await listen(http.createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    if (req.url === '/api/assistant/chat') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' });
      let i = 0;
      const tick = () => {
        i += 1;
        writtenAt.push(Date.now());
        res.write(`event: token\ndata: {"text":"chunk ${i}"}\n\n`);
        if (i < 3) setTimeout(tick, gapMs);
        else res.end('event: done\ndata: {}\n\n');
      };
      tick();
      return;
    }
    if (req.url === '/api/assistant/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"available":true}');
      return;
    }
    // Anything else (a query route) never answers.
  }));
  return { url, seen, writtenAt };
}

async function gateway(targets: { assistant: string; other: string }, timeoutMs: number, assistantTimeoutMs?: number) {
  const app = express();
  app.use(requestLogger(pino({ level: 'silent' })));
  app.use((req, _res, next) => {
    req.user = REP;
    next();
  });
  app.all('/api/*splat', proxy({
    targets: { query: targets.other, 'crm-write': targets.other, notifier: targets.other, assistant: targets.assistant },
    internalToken: 'internal-secret',
    timeoutMs,
    timeouts: assistantTimeoutMs ? { assistant: assistantTimeoutMs } : undefined,
    maxBodyBytes: 65_536,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return { server, port: (server.address() as AddressInfo).port };
}

describe('gateway -> assistant', () => {
  it('reads ASSISTANT_URL and ASSISTANT_TIMEOUT_MS (defaults 8085 and 90 s)', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({ assistantUrl: 'http://localhost:8085', assistantTimeoutMs: 90_000 });
    expect(loadConfig({ NODE_ENV: 'test', ASSISTANT_URL: 'http://assistant:8085', ASSISTANT_TIMEOUT_MS: '1234' }))
      .toMatchObject({ assistantUrl: 'http://assistant:8085', assistantTimeoutMs: 1234 });
  });

  it('forwards the event stream chunk by chunk, not buffered', async () => {
    const up = await fakeAssistant(200);
    const gw = await gateway({ assistant: up.url, other: up.url }, 5000);
    const received: { at: number; text: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gw.port, path: '/api/assistant/chat', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (c: string) => received.push({ at: Date.now(), text: c }));
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end('{}');
    });
    const body = received.map((r) => r.text).join('');
    expect(body).toContain('chunk 1');
    expect(body).toContain('chunk 3');
    expect(body).toContain('event: done');
    // The first chunk reached the client before the upstream had even written the third.
    const firstAt = received.find((r) => r.text.includes('chunk 1'))!.at;
    expect(firstAt).toBeLessThan(up.writtenAt[2]!);
  });

  it('gives the assistant its own deadline while other upstreams keep theirs', async () => {
    const up = await fakeAssistant(300); // ~600 ms stream
    const gw = await gateway({ assistant: up.url, other: up.url }, 150, 3000);
    const slow = await request(gw.server).get('/api/leads/slow');
    expect(slow.status).toBe(504);
    const res = await request(gw.server).post('/api/assistant/chat').send({}).buffer(true).parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (data += c));
      r.on('end', () => cb(null, data));
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('chunk 3');
    expect(res.body).toContain('event: done');
  });

  it('sets the identity headers itself and drops spoofed ones', async () => {
    const up = await fakeAssistant(10);
    const gw = await gateway({ assistant: up.url, other: up.url }, 5000);
    const res = await request(gw.server).get('/api/assistant/status')
      .set('x-user-id', OTHER).set('x-user-role', 'manager').set('x-internal-token', 'forged');
    expect(res.status).toBe(200);
    const seen = up.seen.find((s) => s.url === '/api/assistant/status')!;
    expect(seen.headers['x-user-id']).toBe(REP.id);
    expect(seen.headers['x-user-role']).toBe('rep');
    expect(seen.headers['x-internal-token']).toBe('internal-secret');
  });

  it('answers 502 upstream_unavailable when the assistant is down (the drawer shows offline)', async () => {
    const dead = http.createServer();
    const url = await listen(dead);
    dead.close();
    servers.pop();
    const up = await fakeAssistant(10);
    const gw = await gateway({ assistant: url, other: up.url }, 5000);
    const res = await request(gw.server).post('/api/assistant/chat').send({ messages: [] });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_unavailable', upstream: 'assistant' });
  });

  it('refuses methods the assistant does not serve', async () => {
    const up = await fakeAssistant(10);
    const gw = await gateway({ assistant: up.url, other: up.url }, 5000);
    expect((await request(gw.server).put('/api/assistant/chat').send({})).status).toBe(404);
    expect((await request(gw.server).delete('/api/assistant/status')).status).toBe(404);
    expect(up.seen).toEqual([]);
  });
});
