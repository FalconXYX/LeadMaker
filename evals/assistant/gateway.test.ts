// --via-gateway plumbing against a local stand-in for the gateway (no stack, no model): dev-login per role, the
// chat request the drawer sends, SSE parsing, pre-stream errors.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCases } from '../lib/cases.ts';
import { USERS } from './fixture-query.ts';
import { runCase, type RunEnv } from './runner.ts';

let server: Server;
let url = '';
const seen: { path: string; auth?: string; body: unknown }[] = [];

async function body(req: IncomingMessage): Promise<unknown> {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : null;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const b = await body(req);
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: b });
    if (req.url === '/auth/dev-login') {
      const email = (b as { email: string }).email;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: `token-for-${email}` }));
      return;
    }
    if (req.url === '/api/assistant/chat') {
      const text = (b as { messages: { content: string }[] }).messages.at(-1)!.content;
      if (text.includes('Delete')) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }).end(JSON.stringify({ error: 'rate_limited', retryAfterMs: 3000 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(': ok\n\n');
      res.write(`event: tool\ndata: ${JSON.stringify({ name: 'apply_filter', filter: { scope: 'mine', followUp: 'overdue' }, explanation: 'Overdue follow-ups', matchCount: 4, matchCountCapped: false })}\n\n`);
      await new Promise((r) => setTimeout(r, 20));
      res.write('event: token\ndata: {"text":"4 leads match."}\n\n');
      res.end('event: done\ndata: {"usage":{"llmCalls":1,"inputTokens":900,"outputTokens":40,"ms":25},"promptVersion":"assistant/v1"}\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('via gateway', () => {
  const nl = new Map(loadCases('nl_filter').map((c) => [c.id, c]));

  it('logs in once per role, sends the drawer request and grades the parsed stream', async () => {
    const env: RunEnv = { mode: 'gateway', provider: null, now: new Date(), gatewayUrl: url, tokens: new Map() };
    const rec = await runCase('nl_filter', nl.get('nl-08')!, env);
    expect(rec.contractFailures).toEqual([]);
    expect(rec.pass).toBe(true);
    expect(rec.llmCalls).toBe(1);
    expect(rec.inputTokens).toBe(900);
    await runCase('nl_filter', nl.get('nl-09')!, env);
    const logins = seen.filter((s) => s.path === '/auth/dev-login');
    expect(logins).toHaveLength(1);
    expect(logins[0]!.body).toEqual({ email: USERS.rep1.email });
    const chat = seen.filter((s) => s.path === '/api/assistant/chat');
    expect(chat[0]!.auth).toBe(`Bearer token-for-${USERS.rep1.email}`);
    expect(chat[0]!.body).toEqual({ messages: [{ role: 'user', content: 'Leads with an overdue follow-up' }], context: { page: 'leads' } });
  });

  it('a manager case logs in as the manager; a pre-stream error is a contract failure, not a crash', async () => {
    const env: RunEnv = { mode: 'gateway', provider: null, now: new Date(), gatewayUrl: url, tokens: new Map() };
    await runCase('nl_filter', nl.get('nl-29')!, env);
    expect(seen.some((s) => s.path === '/auth/dev-login' && (s.body as { email: string }).email === USERS.manager.email)).toBe(true);
    const rec = await runCase('nl_filter', nl.get('nl-43')!, env);
    expect(rec.pass).toBe(false);
    expect(rec.contractFailures.join(' ')).toMatch(/answered 429 before streaming/);
  });
});
