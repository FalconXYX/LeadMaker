import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, Outlet, RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import type { SessionUser } from '@/api/types';
import { AuthProvider } from '@/auth/AuthContext';
import { sessionStore } from '@/auth/session';
import { AssistantLauncher } from '@/features/assistant';

const rep: SessionUser = { id: '33333333-3333-4333-8333-333333333333', name: 'Sam Rivera', email: 'rep3@demo.local', role: 'rep' };
const LEAD = 'c0ffee00-0000-4000-8000-000000000001';
const OTHER = 'c0ffee00-0000-4000-8000-000000000002';

const enc = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const jwt = () => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
};
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/** An SSE response whose chunks the test pushes one at a time. */
function controlledStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  return {
    response: () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (s: string) => act(async () => {
      ctrl.enqueue(enc.encode(s));
      await new Promise((r) => setTimeout(r, 0));
    }),
    close: () => act(async () => {
      try {
        ctrl.close();
      } catch {
        /* the client already cancelled the stream (it stops reading after `done`) */
      }
      await new Promise((r) => setTimeout(r, 0));
    }),
  };
}

const sse = (body: string) => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    c.enqueue(enc.encode(body));
    c.close();
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

interface ChatCall { messages: { role: string; content: string }[]; context: Record<string, unknown> }

function setup(opts: {
  path?: string;
  chat?: (body: ChatCall) => Response | Promise<Response>;
  /** GET /api/assistant/status; the default is the route missing (404), i.e. offline. */
  status?: () => Response;
} = {}) {
  const chats: ChatCall[] = [];
  const statusCalls: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/me') return json(rep);
    if (url.pathname === '/api/assistant/status') {
      statusCalls.push(Date.now());
      return opts.status ? opts.status() : json({ error: 'not_found' }, 404);
    }
    if (url.pathname === '/api/assistant/chat') {
      const body = JSON.parse(String(init?.body)) as ChatCall;
      chats.push(body);
      return opts.chat ? opts.chat(body) : json({ error: 'not_found' }, 404);
    }
    const lead = /^\/api\/leads\/([^/]+)$/.exec(url.pathname);
    if (lead) {
      const name = lead[1] === LEAD ? 'Acme Roofing' : 'Brick City Roofers';
      return json({ id: lead[1], fields: { business_name: { value: name } } });
    }
    return json({ error: 'not_found' }, 404);
  }));

  act(() => sessionStore.set({ token: jwt(), user: rep }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Where() {
    const l = useLocation();
    return <p data-testid="location">{l.pathname}{l.search}</p>;
  }
  // Mirrors AppShell: the launcher sits beside the routed outlet.
  function Shell() {
    return (
      <>
        <nav>
          <Link to="/">Dashboard</Link>
          <Link to="/leads">Leads</Link>
          <Link to={`/leads/${LEAD}`}>Acme</Link>
        </nav>
        <Outlet />
        <Where />
        <AssistantLauncher />
      </>
    );
  }
  const router = createMemoryRouter([{
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <h1>Dashboard</h1> },
      { path: 'leads', element: <h1>Leads</h1> },
      { path: 'leads/:id', element: <h1>Profile</h1> },
    ],
  }], { initialEntries: [opts.path ?? '/'] });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider><RouterProvider router={router} /></AuthProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const where = () => screen.getByTestId('location').textContent;
  const launcher = () => screen.getByRole('button', { name: /ai assistant/i });
  const openPanel = async () => {
    await user.click(launcher());
    return screen.getByRole('region', { name: 'AI Assistant' });
  };
  const input = () => screen.getByRole('textbox', { name: 'Message the assistant' });
  const statusLine = () => screen.getByTestId('assistant-status');
  return { user, chats, statusCalls, router, where, launcher, openPanel, input, statusLine };
}

afterEach(() => {
  act(() => sessionStore.set(null));
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const STATUS_OK = {
  available: true, reason: 'ok', provider: 'gemini', model: 'gemini-3.8-flash', resetsAt: null,
  limits: { perMinute: 6, perDay: 150, usedToday: 3 },
};

describe('AssistantLauncher', () => {
  it('opens with focus in the message box and closes with Esc, returning focus to the launcher', async () => {
    const t = setup();
    expect(screen.queryByRole('region', { name: 'AI Assistant' })).not.toBeInTheDocument();
    expect(t.launcher()).toHaveAttribute('aria-expanded', 'false');
    await t.openPanel();
    expect(t.input()).toHaveFocus();
    expect(t.launcher()).toHaveAttribute('aria-expanded', 'true');
    // Non-modal on desktop: no open "dialog" to swallow other pages' Esc handling.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await t.user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'AI Assistant' })).not.toBeInTheDocument();
    expect(t.launcher()).toHaveFocus();
  });

  it('Enter sends, Shift+Enter adds a new line', async () => {
    const t = setup();
    await t.openPanel();
    await t.user.type(t.input(), 'line one{Shift>}{Enter}{/Shift}line two');
    expect(t.input()).toHaveValue('line one\nline two');
    expect(t.chats).toHaveLength(0);
    await t.user.keyboard('{Enter}');
    await waitFor(() => expect(t.chats).toHaveLength(1));
    expect(t.chats[0]!.messages).toEqual([{ role: 'user', content: 'line one\nline two' }]);
    expect(t.input()).toHaveValue('');
  });

  describe('offline (the AI service is not running)', () => {
    it.each([
      ['404', () => json({ error: 'not_found' }, 404)],
      ['502', () => new Response('Bad Gateway', { status: 502 })],
    ])('shows a calm notice on %s, invents nothing, and keeps the suggestions', async (_s, res) => {
      const t = setup({ path: '/leads', chat: res, status: () => json(STATUS_OK) });
      const panel = await t.openPanel();
      await t.user.click(within(panel).getByRole('button', { name: 'Storm-restoration roofers I haven’t contacted' }));

      const notice = await within(panel).findByText('The assistant is offline right now. Nothing was answered or made up.');
      // Neutral, not a warning or an error colour.
      expect(notice.closest('[role="note"]')).toHaveClass('bg-surface-2');
      expect(notice.closest('[role="note"]')?.className).not.toMatch(/warning|danger/);
      expect(within(panel).getByText('Storm-restoration roofers I haven’t contacted', { selector: 'div' })).toBeInTheDocument(); // the question
      expect(t.statusLine()).toHaveTextContent('Offline');
      // No answer bubble, no filters, no navigation.
      expect(within(panel).queryByText('Applied filters')).not.toBeInTheDocument();
      expect(t.where()).toBe('/leads');
      // Suggestions stay available.
      expect(within(panel).getByText('Find leads like…')).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: /Commercial flat-roof contractors in Bergen County/ })).toBeEnabled();
      expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('Try again re-sends the same question', async () => {
      const t = setup({ chat: () => json({ error: 'not_found' }, 404) });
      const panel = await t.openPanel();
      await t.user.type(t.input(), 'hello{Enter}');
      await t.user.click(await within(panel).findByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(t.chats).toHaveLength(2));
      expect(t.chats[1]!.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(within(panel).getAllByText('hello')).toHaveLength(1);
    });
  });

  it('streams an answer: typing indicator, markdown-lite text, citation chips, then done', async () => {
    const s = controlledStream();
    const t = setup({ path: `/leads/${LEAD}`, chat: () => s.response() });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'Summarize{Enter}');
    expect(await within(panel).findByTestId('typing')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Stop answering' })).toBeInTheDocument();

    await s.push(ev('token', { text: '**Acme** is a ' }));
    await s.push(ev('token', { text: 'storm roofer. <img src=x onerror="alert(1)"> See [the other one](/leads/' + OTHER + ').' }));
    const log = within(panel).getByRole('log');
    expect(within(log).getByText('Acme', { selector: 'strong' })).toBeInTheDocument();
    expect(within(log).getByText(/<img src=x onerror="alert\(1\)">/)).toBeInTheDocument(); // shown as text
    expect(log.querySelector('img')).toBeNull();
    expect(within(log).getByRole('link', { name: 'the other one' })).toHaveAttribute('href', `/leads/${OTHER}`);
    expect(within(panel).queryByTestId('typing')).not.toBeInTheDocument();
    expect(log.querySelector('[aria-busy="true"]')).not.toBeNull();

    await s.push(ev('citation', { leadId: LEAD, field: 'contacts' }) + ev('citation', { leadId: OTHER, field: 'notes', leadName: 'Brick City Roofers' }) + ev('citation', { leadId: LEAD, field: 'customTags' }) + ev('citation', { leadId: LEAD, field: 'website' }));
    await s.push(ev('done', {}));
    await s.close();
    expect(within(log).getByRole('link', { name: 'Contacts' })).toHaveAttribute('href', `/leads/${LEAD}?tab=contacts`);
    // Tags and custom fields are on the "Tags & fields" tab; company details and the website on Overview.
    expect(within(log).getByRole('link', { name: 'Custom tags' })).toHaveAttribute('href', `/leads/${LEAD}?tab=tags`);
    expect(within(log).getByRole('link', { name: 'Website' })).toHaveAttribute('href', `/leads/${LEAD}`);
    expect(within(log).getByRole('link', { name: 'Brick City Roofers · Notes' })).toHaveAttribute('href', `/leads/${OTHER}`);
    expect(log.querySelector('[aria-busy="true"]')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('apply_filter navigates to /leads with the filter, and Undo / Apply again move between the two lists', async () => {
    const t = setup({
      path: '/leads?segment=strategic',
      chat: () => sse(
        ev('token', { text: 'Here you go.' })
        + ev('tool', {
          name: 'apply_filter',
          filter: { services: ['storm_damage'], unserviced: 'me', bogus: 1, minRating: 'high' },
          sort: { by: 'rating', dir: 'desc' },
          explanation: 'Storm work you have not contacted, best rated first.',
        })
        + ev('done', {}),
      ),
    });
    const panel = await t.openPanel();
    await t.user.type(t.input(), "Storm-restoration roofers I haven't contacted{Enter}");

    await waitFor(() => expect(t.where()).toBe('/leads?service=storm_damage&unserviced=me&sort=rating%3Adesc'));
    // The current list filter went up as context.
    expect(t.chats[0]!.context).toEqual({ page: 'leads', filter: { segment: ['strategic'] } });

    const card = (await within(panel).findByText('Applied filters')).closest('div.rounded-xl') as HTMLElement;
    expect(within(card).getByText('Storm work you have not contacted, best rated first.')).toBeInTheDocument();
    const chips = within(card).getByRole('list', { name: 'Filters' });
    expect(within(chips).getByText('Storm damage')).toBeInTheDocument();
    expect(within(chips).getByText('by me')).toBeInTheDocument();
    expect(within(chips).getByText('Rating ↓')).toBeInTheDocument();
    expect(within(chips).queryByText(/high/)).not.toBeInTheDocument(); // junk was dropped

    await t.user.click(within(card).getByRole('button', { name: 'Undo' }));
    expect(t.where()).toBe('/leads?segment=strategic');
    expect(within(panel).getByText('Filters undone')).toBeInTheDocument();

    await t.user.click(within(panel).getByRole('button', { name: 'Apply again' }));
    expect(t.where()).toBe('/leads?service=storm_damage&unserviced=me&sort=rating%3Adesc');
    expect(within(panel).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('apply_filter from the dashboard opens the list; Undo returns to the dashboard', async () => {
    const t = setup({
      chat: () => sse(ev('tool', { name: 'apply_filter', filter: { minRating: 4.5 }, explanation: '' }) + ev('done', {})),
    });
    const panel = await t.openPanel();
    await t.user.type(t.input(), '4.5 stars{Enter}');
    await waitFor(() => expect(t.where()).toBe('/leads?minRating=4.5'));
    expect(screen.getByRole('heading', { name: 'Leads' })).toBeInTheDocument();
    await t.user.click(within(panel).getByRole('button', { name: 'Undo' }));
    expect(t.where()).toBe('/');
  });

  it('open_lead navigates to the profile', async () => {
    const t = setup({ chat: () => sse(ev('tool', { name: 'open_lead', leadId: OTHER }) + ev('done', {})) });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'open brick city{Enter}');
    await waitFor(() => expect(t.where()).toBe(`/leads/${OTHER}`));
    expect(within(panel).getByRole('link', { name: /Opened lead/ })).toHaveAttribute('href', `/leads/${OTHER}`);
  });

  it('an error event shows inline with a retry, keeping the partial answer', async () => {
    const t = setup({ chat: () => sse(ev('token', { text: 'Partial answer' }) + ev('error', { message: 'The model timed out.' })) });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'hi{Enter}');
    expect(await within(panel).findByText('The model timed out.')).toBeInTheDocument();
    expect(within(panel).getByText('Partial answer')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('on a profile: "Asking about <lead>", profile prompts, and the lead id as context', async () => {
    const t = setup({ path: `/leads/${LEAD}`, chat: () => sse(ev('token', { text: 'ok' }) + ev('done', {})) });
    const panel = await t.openPanel();
    expect(await within(panel).findByText('Acme Roofing', { selector: 'strong' })).toBeInTheDocument();
    expect(within(panel).getByText(/Asking about/)).toBeInTheDocument();
    // The pitch prompt follows the lead's timing data: no storm badge, no storm framing (product review M4).
    for (const p of ['Summarize this contractor', 'Who should I contact and why?', 'What should I pitch to them?']) {
      expect(within(panel).getByRole('button', { name: p })).toBeInTheDocument();
    }
    await t.user.click(within(panel).getByRole('button', { name: 'Who should I contact and why?' }));
    await waitFor(() => expect(t.chats).toHaveLength(1));
    expect(t.chats[0]!.context).toEqual({ page: 'profile', leadId: LEAD });
  });

  it('keeps the conversation across route changes and sends it as history', async () => {
    let n = 0;
    const t = setup({ chat: () => sse(ev('token', { text: `answer ${++n}` }) + ev('done', {})) });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'first question{Enter}');
    expect(await within(panel).findByText('answer 1')).toBeInTheDocument();

    await act(() => t.router.navigate('/leads'));
    expect(screen.getByRole('heading', { name: 'Leads' })).toBeInTheDocument();
    expect(within(panel).getByText('first question')).toBeInTheDocument();
    expect(within(panel).getByText('answer 1')).toBeInTheDocument();

    await t.user.type(t.input(), 'second{Enter}');
    expect(await within(panel).findByText('answer 2')).toBeInTheDocument();
    expect(t.chats[1]!.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'second' },
    ]);
    expect(t.chats[1]!.context).toEqual({ page: 'leads', filter: {} });
  });

  it('phones: a modal overlay; "View matching leads" closes it to show the list', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('min-width'), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    const t = setup({ chat: () => sse(ev('tool', { name: 'apply_filter', filter: { minRating: 4.5 }, explanation: '' }) + ev('done', {})) });
    await t.user.click(t.launcher());
    const overlay = screen.getByRole('dialog', { name: 'AI Assistant' });
    expect(overlay).toHaveAttribute('aria-modal', 'true');
    await t.user.type(t.input(), '4.5 stars{Enter}');
    await waitFor(() => expect(t.where()).toBe('/leads?minRating=4.5'));
    await t.user.click(within(overlay).getByRole('link', { name: /View matching leads/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(t.where()).toBe('/leads?minRating=4.5');
  });

  it('restores the finished conversation after a reload, and forgets it on sign-out', async () => {
    const t = setup({ chat: () => sse(ev('token', { text: 'kept answer' }) + ev('done', {})) });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'remember me{Enter}');
    expect(await within(panel).findByText('kept answer')).toBeInTheDocument();
    cleanup(); // "reload"

    const again = setup();
    const restored = await again.openPanel();
    expect(within(restored).getByText('remember me')).toBeInTheDocument();
    expect(within(restored).getByText('kept answer')).toBeInTheDocument();

    act(() => sessionStore.set(null));
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('leadmaker.assistant.'))).toEqual([]);
  });

  it('Stop ends the answer and New conversation clears it', async () => {
    const s = controlledStream();
    const t = setup({ chat: () => s.response() });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'hi{Enter}');
    await s.push(ev('token', { text: 'Half an' }));
    await t.user.click(within(panel).getByRole('button', { name: 'Stop answering' }));
    expect(await within(within(panel).getByRole('log')).findByText('Stopped.')).toBeInTheDocument();
    await t.user.click(within(panel).getByRole('button', { name: 'New conversation' }));
    expect(within(panel).queryByText('Half an')).not.toBeInTheDocument();
    expect(within(panel).getByText(/how can I help/)).toBeInTheDocument();
  });
});

describe('AssistantLauncher with the AI service (Section 4)', () => {
  it.each([
    ['ok', STATUS_OK, 'Lead Q&A and list filtering'],
    ['not_configured', { ...STATUS_OK, available: false, reason: 'not_configured', provider: null, model: null }, 'AI isn’t set up on this server'],
    ['provider_down', { ...STATUS_OK, available: false, reason: 'provider_down' }, 'AI temporarily unavailable'],
  ])('the status line reads /status when the panel opens: %s', async (_r, body, line) => {
    const t = setup({ status: () => json(body) });
    expect(t.statusCalls).toHaveLength(0); // nothing is read while the panel is closed
    await t.openPanel();
    await waitFor(() => expect(t.statusLine()).toHaveTextContent(line));
    expect(t.statusLine().textContent).toBe(line);
    expect(t.statusCalls).toHaveLength(1);
  });

  it('the status line shows when the daily quota resets', async () => {
    const t = setup({ status: () => json({ ...STATUS_OK, available: false, reason: 'quota_exhausted', resetsAt: '2026-10-20T07:00:00Z' }) });
    await t.openPanel();
    await waitFor(() => expect(t.statusLine()).toHaveTextContent(/^Daily AI limit reached · back (today|tomorrow|[A-Z][a-z]+day) 3:00\s?AM ET$/));
    // Nothing invites a question that would only fail (product review M2): one neutral line, the box closed.
    expect(screen.getByTestId('assistant-paused')).toHaveTextContent(/AI answers are paused until .* 3:00\s?AM ET\. Filters and profiles work as usual\./);
    expect(t.input()).toBeDisabled();
    expect(screen.queryByRole('button', { name: /call first/i })).not.toBeInTheDocument();
  });

  it.each([
    ['404', () => json({ error: 'not_found' }, 404)],
    ['502', () => new Response('Bad Gateway', { status: 502 })],
  ])('the status line says Offline when /status is %s, with no warning dot', async (_s, res) => {
    const t = setup({ status: res });
    const panel = await t.openPanel();
    await waitFor(() => expect(t.statusLine()).toHaveTextContent('Offline'));
    expect(panel.querySelector('.bg-warning')).toBeNull();
  });

  it('streams a server-written error without Try again when a retry can’t help, as a neutral note', async () => {
    const t = setup({
      status: () => json(STATUS_OK),
      chat: () => sse(ev('error', {
        message: 'The AI’s daily limit is used up. It resets at 3:00 AM ET.', code: 'ai_quota_exhausted', retryable: false, resetsAt: '2026-10-20T07:00:00Z',
      })),
    });
    const panel = await t.openPanel();
    await waitFor(() => expect(t.statusCalls).toHaveLength(1));
    await t.user.type(t.input(), 'Summarize{Enter}');
    const msg = await within(panel).findByText('The AI’s daily limit is used up. It resets at 3:00 AM ET.');
    const note = msg.closest('[data-tone]') as HTMLElement;
    expect(note).toHaveAttribute('data-tone', 'limit');
    expect(note).toHaveClass('bg-surface-2');
    expect(note.className).not.toMatch(/danger/);
    expect(within(panel).queryByRole('button', { name: 'Try again' })).toBeNull();
    // The failure may have changed the server's state: the status is read again.
    await waitFor(() => expect(t.statusCalls).toHaveLength(2));
  });

  it.each([
    ['ai_not_configured', 'AI isn’t set up on this server yet, so the assistant can’t answer. Lists, filters and profiles work as usual.'],
    ['user_daily_limit', 'You’ve reached today’s limit of 150 assistant questions. It resets at midnight ET.'],
  ])('%s: no Try again', async (code, message) => {
    const t = setup({ status: () => json(STATUS_OK), chat: () => sse(ev('error', { message, code, retryable: false })) });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'hi{Enter}');
    expect(await within(panel).findByText(message)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a retryable provider error keeps Try again and the error tone', async () => {
    const t = setup({
      status: () => json(STATUS_OK),
      chat: () => sse(ev('error', { message: 'The AI service didn’t respond. Try again in a moment.', code: 'ai_provider_error', retryable: true })),
    });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'hi{Enter}');
    const msg = await within(panel).findByText('The AI service didn’t respond. Try again in a moment.');
    expect(msg.closest('[data-tone]')).toHaveAttribute('data-tone', 'error');
    expect(msg.closest('[role="alert"]')).toHaveClass('bg-danger-soft');
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('before the stream: 429 is a neutral note with Try again; lead_not_found has no retry', async () => {
    let n = 0;
    const t = setup({
      path: `/leads/${LEAD}`,
      status: () => json(STATUS_OK),
      chat: () => (++n === 1
        ? new Response(JSON.stringify({ error: 'rate_limited', retryAfterMs: 3000 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3' } })
        : json({ error: 'lead_not_found' }, 404)),
    });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'Summarize{Enter}');
    const limited = await within(panel).findByText('Too many requests. Try again in 3s.');
    expect(limited.closest('[data-tone]')).toHaveAttribute('data-tone', 'limit');
    await t.user.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await within(panel).findByText('Not found, or you no longer have access.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(t.where()).toBe(`/leads/${LEAD}`);
  });

  it('apply_filter carries every list key (stages, counties, follow-up, dates, priority, new) and the match count', async () => {
    const t = setup({
      status: () => json(STATUS_OK),
      chat: () => sse(
        ev('tool', {
          name: 'apply_filter',
          filter: {
            scope: 'mine', stages: ['interested', 'quoting'], counties: ['34003', '36047'], followUp: 'overdue',
            notContactedSince: '2026-10-05', minPriority: 70, updatedInLastPoll: true,
          },
          explanation: 'Warm deals in Bergen and Brooklyn with overdue follow-ups',
          matchCount: 37,
          matchCountCapped: false,
        })
        + ev('token', { text: '37 leads match.' })
        + ev('done', { usage: { llmCalls: 1, inputTokens: 2310, outputTokens: 58, ms: 1840 }, promptVersion: 'assistant/v1' }),
      ),
    });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'warm deals with overdue follow-ups{Enter}');
    await waitFor(() => expect(t.where()).toBe(
      '/leads?scope=mine&stage=interested&stage=quoting&county=34003&county=36047&followUp=overdue&notContactedSince=2026-10-05&minPriority=70&new=1',
    ));
    const card = (await within(panel).findByText('Applied filters')).closest('div.rounded-xl') as HTMLElement;
    const count = within(card).getByText('· 37 leads');
    expect(count).toHaveClass('text-xs', 'text-muted');
    const chips = within(within(card).getByRole('list', { name: 'Filters' }));
    // Eight chips fit; the ninth ("New: Changed in last poll") folds into "+1 more".
    // Facets and labels match the list's own chips (product review L4).
    for (const label of ['My leads', 'Interested', 'Quoting', 'Bergen', 'Brooklyn', 'overdue', 'since Oct 5', '70+', '+1 more']) {
      expect(chips.getByText(label)).toBeInTheDocument();
    }
    // The card shows the count, so the server's "37 leads match." bubble is not repeated.
    expect(within(panel).queryByText('37 leads match.')).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('a capped count reads 1,000+ leads', async () => {
    const t = setup({
      status: () => json(STATUS_OK),
      chat: () => sse(ev('tool', { name: 'apply_filter', filter: { scope: 'all' }, explanation: 'Everything', matchCount: 1000, matchCountCapped: true }) + ev('done', {})),
    });
    const panel = await t.openPanel();
    await t.user.type(t.input(), 'everything{Enter}');
    expect(await within(panel).findByText('· 1,000+ leads')).toBeInTheDocument();
  });
});
