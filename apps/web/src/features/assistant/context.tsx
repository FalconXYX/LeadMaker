// The assistant's state, shared by the launcher and the panel. It lives in AppShell (via AssistantLauncher),
// so the conversation and an in-flight answer survive route changes; a reload restores finished messages.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext, use, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  ApiError, NetworkError, NotFoundError, RateLimitedError, ServiceBusyError, UnauthorizedError, errorMessage,
} from '@/api/errors';
import { qk } from '@/api/queries';
import { useAuth } from '@/auth/AuthContext';
import { leadsHref } from '@/lib/filterUrl';
import {
  AssistantUnavailableError, getAssistantStatus, streamAssistantChat, type AssistantEvent, type AssistantStatusView,
} from './api';
import { ASK_EVENT, type AskDetail } from './ask';
import { coerceFilter } from './filters';
import { isLeadHref } from './markdown';
import { usePageContext, type PageContext } from './pageContext';
import { loadConversation, saveConversation } from './persistence';
import {
  buildHistory, emptyReply, newId, reducer, replyErrorText, type AssistantMessage, type ChatMessage, type FilterPart, type ReplyError,
  type UserMessage,
} from './state';

export type Connection = 'unknown' | 'connected' | 'unavailable';

export interface AssistantContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  messages: ChatMessage[];
  /** An answer is streaming. */
  busy: boolean;
  /** Learned from the last request: the AI service answered, or is offline. */
  connection: Connection;
  /** GET /api/assistant/status, read while the panel is open; null until it arrives (or when it failed). */
  status: AssistantStatusView | null;
  /** A reply finished while the panel was closed. */
  unread: boolean;
  page: PageContext;
  /** Screen-reader status line (filters applied, not connected, …). */
  announcement: string;
  send: (text: string) => void;
  stop: () => void;
  retry: (replyId: string) => void;
  reset: () => void;
  undoFilter: (part: FilterPart) => void;
  reapplyFilter: (part: FilterPart) => void;
  /** Called after the user follows a link out of the panel (phones close the overlay). */
  onNavigate: () => void;
  /** The panel is a full-screen overlay (below md). */
  isOverlay: boolean;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function useAssistant(): AssistantContextValue {
  const ctx = use(AssistantContext);
  if (!ctx) throw new Error('useAssistant must be used inside <AssistantProvider>');
  return ctx;
}

const LEAD_ID = /^[A-Za-z0-9-]{1,64}$/;

const STATUS_ANNOUNCEMENTS: Record<Exclude<AssistantMessage['status'], 'streaming'>, string> = {
  done: 'The assistant replied.',
  stopped: 'Stopped.',
  interrupted: 'The answer was cut off.',
  error: 'The assistant couldn’t answer.',
  unavailable: 'The assistant is offline right now.',
};

/** A failure before the stream started, as the reply's error: the client's copy, and whether a retry can help. */
export function requestError(err: unknown): ReplyError {
  const message = errorMessage(err);
  if (err instanceof RateLimitedError) return { message, code: 'rate_limited', retryable: true };
  if (err instanceof ServiceBusyError || err instanceof NetworkError) return { message, code: err instanceof NetworkError ? 'network' : 'busy', retryable: true };
  if (err instanceof NotFoundError) return { message, code: err.code, retryable: false };
  if (err instanceof UnauthorizedError) return { message, code: err.code, retryable: false };
  if (err instanceof ApiError && err.status === 400) {
    return {
      message: 'The assistant couldn’t take that question. Try a shorter one, or start a new conversation.',
      code: err.code,
      retryable: false,
    };
  }
  if (err instanceof ApiError) return { message, code: err.code };
  return { message };
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpenState] = useState(false);
  const [messages, dispatch] = useReducer(reducer, userId, (id) => (id ? loadConversation(id) : []));
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>('unknown');
  const [unread, setUnread] = useState(false);
  const [announcement, setAnnouncementText] = useState('');
  // The same message twice in a row must still be read out: vary it invisibly.
  const setAnnouncement = useCallback((msg: string) => setAnnouncementText((prev) => (prev === msg ? `${msg}\u00a0` : msg)), []);
  const page = usePageContext(open);
  const isOverlay = !useMediaQuery('(min-width: 768px)');
  const qc = useQueryClient();
  // Only while the panel is open: the status line needs it, nothing else does.
  const statusQuery = useQuery({
    queryKey: qk.assistantStatus,
    queryFn: ({ signal }) => getAssistantStatus({ signal }),
    enabled: open && !!userId,
    staleTime: 60_000,
    retry: false,
  });
  const status = statusQuery.isError ? null : statusQuery.data ?? null;

  const abortRef = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const hrefRef = useRef('');
  hrefRef.current = location.pathname + location.search;
  const pageRef = useRef(page);
  pageRef.current = page;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const statusRef = useRef(status);
  statusRef.current = status;

  // Another account signed in on this tab: never show the previous user's conversation.
  const loadedFor = useRef(userId);
  useEffect(() => {
    if (loadedFor.current === userId) return;
    loadedFor.current = userId;
    abortRef.current?.abort();
    dispatch({ type: 'load', messages: userId ? loadConversation(userId) : [] });
  }, [userId]);

  useEffect(() => {
    if (userId && !busy) saveConversation(userId, messages);
  }, [userId, busy, messages]);

  // Leaving the app (sign-out) ends any answer in flight.
  useEffect(() => () => abortRef.current?.abort(), []);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (next) setUnread(false);
  }, []);

  const handleTool = useCallback((replyId: string, ev: Extract<AssistantEvent, { type: 'tool' }>) => {
    if (ev.name === 'apply_filter') {
      const filter = coerceFilter(ev.filter, ev.sort);
      if (!filter) {
        dispatch({ type: 'part', id: replyId, part: { kind: 'filter-invalid', id: newId('f'), explanation: ev.explanation } });
        return;
      }
      const href = leadsHref(filter);
      dispatch({
        type: 'part',
        id: replyId,
        part: {
          kind: 'filter', id: newId('f'), filter, explanation: ev.explanation, href, prevHref: hrefRef.current, undone: false,
          ...(ev.matchCount !== undefined ? { matchCount: ev.matchCount, matchCountCapped: ev.matchCountCapped === true } : {}),
        },
      });
      if (hrefRef.current !== href) navigate(href);
      setAnnouncement('Filters applied to the lead list.');
    } else if (ev.name === 'open_lead' && LEAD_ID.test(ev.leadId)) {
      const href = `/leads/${ev.leadId}`;
      if (!isLeadHref(href)) return;
      dispatch({ type: 'part', id: replyId, part: { kind: 'open-lead', id: newId('o'), leadId: ev.leadId, href } });
      if (hrefRef.current !== href) navigate(href);
      setAnnouncement('Opened the lead profile.');
    }
  }, [navigate, setAnnouncement]);

  const run = useCallback(async (reply: AssistantMessage, question: string, history: ChatMessage[]) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setAnnouncement('The assistant is replying.');
    const request = { messages: buildHistory(history, question), context: pageRef.current.request };
    let finished = false;
    const ended: { status: Exclude<AssistantMessage['status'], 'streaming'> } = { status: 'interrupted' };
    const finish = (status: Exclude<AssistantMessage['status'], 'streaming'>, error?: ReplyError) => {
      finished = true;
      ended.status = status;
      dispatch({ type: 'finish', id: reply.id, status, error });
      setAnnouncement(STATUS_ANNOUNCEMENTS[status] + (status === 'error' && error?.message ? ` ${error.message}` : ''));
    };
    try {
      for await (const ev of streamAssistantChat(request, { signal: ctrl.signal })) {
        if (ev.type === 'token') dispatch({ type: 'token', id: reply.id, text: ev.text });
        else if (ev.type === 'status') dispatch({ type: 'progress', id: reply.id, text: ev.text });
        else if (ev.type === 'citation') dispatch({ type: 'citation', id: reply.id, citation: { leadId: ev.leadId, field: ev.field, leadName: ev.leadName } });
        else if (ev.type === 'tool') handleTool(reply.id, ev);
        else if (ev.type === 'error') finish('error', { message: replyErrorText(ev.code, ev.message), code: ev.code, retryable: ev.retryable });
        else if (ev.type === 'done') finish('done');
        if (finished) break;
      }
      setConnection('connected');
      if (!finished) finish(ctrl.signal.aborted ? 'stopped' : 'interrupted');
    } catch (err) {
      if (ctrl.signal.aborted) finish('stopped');
      else if (err instanceof AssistantUnavailableError) {
        setConnection('unavailable');
        finish('unavailable');
      } else finish('error', requestError(err));
    } finally {
      // The answer may have changed what the status line should say (unavailable, offline, back online, …).
      const failed = ended.status !== 'done' && ended.status !== 'stopped';
      if (failed || statusRef.current?.available === false) void qc.invalidateQueries({ queryKey: qk.assistantStatus });
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setBusy(false);
        if (!openRef.current) setUnread(true);
      }
    }
  }, [handleTool, setAnnouncement, qc]);

  const send = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text || abortRef.current) return;
    const ctx = pageRef.current;
    const user: UserMessage = {
      id: newId('u'),
      role: 'user',
      content: text,
      context: ctx.request,
      contextLabel: ctx.page === 'profile' ? ctx.leadName ?? null : null,
    };
    const reply = emptyReply();
    const history = messagesRef.current;
    dispatch({ type: 'send', user, reply });
    void run(reply, text, history);
  }, [run]);

  const retry = useCallback((replyId: string) => {
    if (abortRef.current) return;
    const all = messagesRef.current;
    const i = all.findIndex((m) => m.id === replyId);
    const question = all[i - 1];
    if (i < 1 || question?.role !== 'user') return;
    const reply = emptyReply();
    dispatch({ type: 'retry', replyId, reply });
    void run(reply, question.content, all.slice(0, i - 1));
  }, [run]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: 'reset' });
    setAnnouncement('Started a new conversation.');
  }, [setAnnouncement]);

  const undoFilter = useCallback((part: FilterPart) => {
    dispatch({ type: 'update-filter', partId: part.id, patch: { undone: true } });
    navigate(part.prevHref || '/leads');
    setAnnouncement('Filters undone.');
  }, [navigate, setAnnouncement]);

  const reapplyFilter = useCallback((part: FilterPart) => {
    dispatch({ type: 'update-filter', partId: part.id, patch: { undone: false, prevHref: hrefRef.current } });
    navigate(part.href);
    setAnnouncement('Filters applied to the lead list.');
  }, [navigate, setAnnouncement]);

  const onNavigate = useCallback(() => {
    if (isOverlay) setOpenState(false);
  }, [isOverlay]);

  // askAssistant(text) from a page (e.g. the dashboard's Ask AI bar): open the panel and send the question.
  useEffect(() => {
    const onAsk = (e: Event) => {
      const text = (e as CustomEvent<AskDetail>).detail?.text;
      if (typeof text !== 'string' || !text.trim()) return;
      setOpen(true);
      send(text);
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [setOpen, send]);

  const value = useMemo<AssistantContextValue>(() => ({
    open, setOpen, messages, busy, connection, status, unread, page, announcement,
    send, stop, retry, reset, undoFilter, reapplyFilter, onNavigate, isOverlay,
  }), [open, setOpen, messages, busy, connection, status, unread, page, announcement, send, stop, retry, reset, undoFilter, reapplyFilter, onNavigate, isOverlay]);

  return <AssistantContext value={value}>{children}</AssistantContext>;
}

/** matchMedia as state; true when matchMedia is unavailable (tests, old browsers). */
function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
