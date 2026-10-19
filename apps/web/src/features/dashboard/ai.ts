// Small helpers for the dashboard's AI content (company insights, the territory brief).

/** The first sentence of `text` (to a . ! or ? followed by a space or the end), trimmed; null when empty. */
export function firstSentence(text: string | null | undefined): string | null {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!t) return null;
  const m = /^(.+?[.!?])(?=\s|$)/.exec(t);
  return (m ? m[1]! : t).trim();
}
