// The conversation survives a reload of the tab (sessionStorage, per user) and is wiped on sign-out.
// Lead details in answers never outlive the tab or cross to another account.
import { sessionStore } from '@/auth/session';
import type { ChatMessage } from './state';

const PREFIX = 'leadmaker.assistant.';
const MAX_MESSAGES = 40;

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function loadConversation(userId: string): ChatMessage[] {
  try {
    const raw = storage()?.getItem(PREFIX + userId);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return (parsed as ChatMessage[])
      .filter((m) => m && (m.role === 'user' || (m.role === 'assistant' && Array.isArray(m.parts))))
      // An answer that was streaming when the tab reloaded will never finish.
      .map((m) => (m.role === 'assistant' && m.status === 'streaming' ? { ...m, status: 'interrupted' as const } : m));
  } catch {
    return [];
  }
}

export function saveConversation(userId: string, messages: ChatMessage[]): void {
  try {
    const s = storage();
    if (!s) return;
    if (messages.length === 0) s.removeItem(PREFIX + userId);
    else {
      let recent = messages.slice(-MAX_MESSAGES);
      const firstQuestion = recent.findIndex((m) => m.role === 'user');
      recent = firstQuestion > 0 ? recent.slice(firstQuestion) : recent;
      s.setItem(PREFIX + userId, JSON.stringify(recent));
    }
  } catch {
    /* quota or disabled storage: the conversation lives in memory only */
  }
}

export function clearAllConversations(): void {
  try {
    const s = storage();
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => s.removeItem(k));
  } catch {
    /* ignore */
  }
}

sessionStore.subscribe(() => {
  if (!sessionStore.get()) clearAllConversations();
});
