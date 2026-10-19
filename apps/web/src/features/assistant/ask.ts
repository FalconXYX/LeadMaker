// Open the assistant and ask a question from anywhere in the app. The assistant's provider lives in AppShell, outside
// the routed pages, so pages reach it with a window event rather than the React context.
export const ASK_EVENT = 'leadmaker:assistant-ask';

export interface AskDetail { text: string }

/** Opens the assistant panel and sends `text` (ignored while an answer is still streaming; the panel still opens). */
export function askAssistant(text: string): void {
  const t = text.trim();
  if (!t || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AskDetail>(ASK_EVENT, { detail: { text: t } }));
}
